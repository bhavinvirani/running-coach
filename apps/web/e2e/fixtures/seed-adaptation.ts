import {
  WALK_RUN_TITLE,
  applyDelta,
  reEntryPlan,
  type AdjustedSession,
} from "@running-coach/engine";
import type {
  SessionStatus,
  SessionSteps,
  SessionTarget,
  SessionType,
} from "@running-coach/shared";
import type pg from "pg";
import { weekStart } from "../../src/lib/dates";
import { UNCATEGORIZED, runner, runnerId, seedPlan, withDatabase } from "./seed";

// The adaptation's seeds: a run on a given day, and seedPlan's plan after a pause, a re-entry and a coach
// change.

/** Garmin ids for seedRunOn: one per local date, far from the fixture account's and runHistory's. */
const SEEDED_DAY_RUN_IDS = 30_000_000_000;

/** A run for seedRunOn: how far and how long. */
export type SeededDayRun = { distanceM: number; durationS: number };

/**
 * Stores a fictional outdoor run at 07:30 on `date`, a local date in the runner's default zone (UTC), as a
 * sync stores it, for a flow or screen that needs a run on a day counted from today or from a seeded plan.
 * Its Garmin id comes from the date, so one run per day; the fixture Garmin never lists it, so a test that
 * stores one must not sync. Returns the run's id.
 */
export async function seedRunOn(
  date: string,
  { distanceM, durationS }: SeededDayRun,
): Promise<string> {
  const { rows } = await withDatabase((db) =>
    db.query<{ id: string }>(
      `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
         duration_s, event_type)
       values (${runnerId}, $2, 'running', $3::timestamp at time zone 'UTC', $3, $4, $5, $6)
       returning id`,
      [
        runner.email,
        SEEDED_DAY_RUN_IDS + Number(date.replaceAll("-", "")),
        `${date} 07:30:00`,
        distanceM,
        durationS,
        UNCATEGORIZED,
      ],
    ),
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`The run on ${date} was not stored`);
  return id;
}

/**
 * The instant the adjusted week's capture pins the browser clock to (page.clock.setFixedTime): Thu 22 Oct
 * 2026, in week 3 (19–25 Oct) of seedPlan's plan, so Mon 19 and Wed 21 are past and Add shows from Thu 22.
 */
export const planWeekThreeAt = new Date("2026-10-22T09:00:00Z");

/** seedAdjustedPlan's story, in the runner's local dates. */
const adjustedStory = {
  /** Sick from the day after the last run, Mon 5 Oct. */
  pausedOn: "2026-10-06",
  /** "I'm back": 9 days after that run, so the return runs at 70% with a walk-run first week. */
  backOn: "2026-10-14",
  daysOff: 9,
  /** The first walk-run of week 3, run and matched. */
  doneOn: "2026-10-19",
  /** The tempo after it, which the coach's review of that run turned easy, then not run. */
  changedOn: "2026-10-21",
} as const;

/** A plan session as seedAdjustedPlan reads it back. */
type StoredPlanSession = {
  id: string;
  date: string;
  type: SessionType;
  status: SessionStatus;
  title: string | null;
  target: SessionTarget;
  steps: SessionSteps;
};

/** The fields a change writes back to the session and logs before and after. */
function adjustedOf({ type, title, status, steps, target }: StoredPlanSession): AdjustedSession {
  return { type, title, status, steps, target };
}

/** One change as the API writes it: the session in place, then its plan_adjustment row. */
type SeededChange = {
  session: StoredPlanSession;
  after: AdjustedSession;
  source: "coach" | "pause";
  kind: "easy" | "re_entry";
  requested: object;
  /** When the change was made, which orders a session's changes. */
  at: string;
  pauseId?: string;
  activityId?: string;
};

async function writeChange(db: pg.Client, change: SeededChange): Promise<StoredPlanSession> {
  const { session, after } = change;
  await db.query(
    `update plan_session set type = $2, title = $3, status = $4, steps = $5::jsonb, target = $6::jsonb
     where id = $1`,
    [
      session.id,
      after.type,
      after.title,
      after.status,
      JSON.stringify(after.steps),
      JSON.stringify(after.target),
    ],
  );
  await db.query(
    `insert into plan_adjustment (user_id, plan_session_id, source, kind, outcome, requested, applied,
       before, after, pause_id, activity_id, created_at, updated_at)
     values (${runnerId}, $2, $3, $4, 'applied', $5::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10,
       $10)`,
    [
      runner.email,
      session.id,
      change.source,
      change.kind,
      JSON.stringify(change.requested),
      JSON.stringify(adjustedOf(session)),
      JSON.stringify(after),
      change.pauseId ?? null,
      change.activityId ?? null,
      change.at,
    ],
  );
  return { ...session, ...after };
}

/**
 * seedPlan's plan after the adaptation had its way with it, for the adjusted week's capture (week 3,
 * 19–25 Oct, at planWeekThreeAt). The runner was sick from Tue 6 Oct and tapped I'm back on Wed 14, 9 days
 * after the last run: the engine's own reEntryPlan eases every session from that day as the API does
 * (source pause), so the first 7 days are walk-run and the weeks after run at 70% and build back up. In
 * week 3 the walk-run of Mon 19 was run (done, linked to its run); the coach's review of that run turned
 * Wed 21's eased tempo into an easy run of the same time (applyDelta, source coach); Wed 21 was then not
 * run (missed); Fri 23 and Sun 25 stay eased. Written directly, with the engine's numbers, so it holds
 * whatever the date; only week 3's past sessions carry what a sync would have matched.
 */
export async function seedAdjustedPlan(): Promise<void> {
  const { pausedOn, backOn, daysOff, doneOn, changedOn } = adjustedStory;
  const { paces } = await seedPlan();
  // A walk-run of 20 minutes, as the session asks.
  const runId = await seedRunOn(doneOn, { distanceM: 3000, durationS: 1260 });

  await withDatabase(async (db) => {
    await db.query("begin");
    try {
      const pauses = await db.query<{ id: string }>(
        `insert into training_pause (user_id, reason, started_on, ended_on, created_at, updated_at)
         values (${runnerId}, 'sick', $2, $3, $4, $5)
         returning id`,
        [runner.email, pausedOn, backOn, `${pausedOn}T07:00:00Z`, `${backOn}T07:00:00Z`],
      );
      const pauseId = pauses.rows[0]?.id;
      if (pauseId === undefined) throw new Error("The pause insert returned nothing");

      // The re-entry reads the sessions from the Monday of the first day back, as the API's does.
      const { rows } = await db.query<StoredPlanSession>(
        `select id, date::text as date, type, status, title, target, steps from plan_session
         where user_id = ${runnerId} and date >= $2
         order by date, id`,
        [runner.email, weekStart(backOn)],
      );
      const sessions = new Map(rows.map((row) => [row.id, row]));
      const reEntry = reEntryPlan({
        fromDate: backOn,
        daysOff,
        walkRun: true,
        sessions: rows.map((row) => ({ ...row, source: "plan" as const })),
        paces,
      });
      for (const { id, session: after } of reEntry.changes) {
        const session = sessions.get(id);
        if (!session) throw new Error(`The re-entry changed a session it was not given: ${id}`);
        sessions.set(
          id,
          await writeChange(db, {
            session,
            after,
            source: "pause",
            kind: "re_entry",
            requested: { factor: reEntry.factor, walkRun: true, daysOff },
            at: `${backOn}T07:00:00Z`,
            pauseId,
          }),
        );
      }

      const onDay = (date: string) => {
        const session = [...sessions.values()].find((candidate) => candidate.date === date);
        if (!session) throw new Error(`The seeded plan has no session on ${date}`);
        return session;
      };
      const done = onDay(doneOn);
      if (done.title !== WALK_RUN_TITLE) throw new Error(`${doneOn} is not a walk-run`);
      await db.query(`update plan_session set status = 'done', activity_id = $2 where id = $1`, [
        done.id,
        runId,
      ]);

      const changed = onDay(changedOn);
      if (changed.type !== "tempo") throw new Error(`${changedOn} is not a tempo`);
      await writeChange(db, {
        session: changed,
        after: applyDelta({ ...changed, source: "plan" }, { kind: "easy" }, paces),
        source: "coach",
        kind: "easy",
        requested: { kind: "easy" },
        // After the walk-run's review, written once the run was in.
        at: `${doneOn}T09:00:00Z`,
        activityId: runId,
      });
      await db.query(`update plan_session set status = 'missed' where id = $1`, [changed.id]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}
