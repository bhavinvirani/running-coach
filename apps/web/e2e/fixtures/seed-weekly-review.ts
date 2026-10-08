import { applyDelta, type AdjustedSession } from "@running-coach/engine";
import type {
  PlanChange,
  PlanDelta,
  PlanPaces,
  ReviewSession,
  ReviewWeekSummary,
  SessionSnapshot,
  SessionStatus,
  SessionSteps,
  SessionTarget,
  SessionType,
  WeeklyReview,
} from "@running-coach/shared";
import { addDays, weekStart } from "../../src/lib/dates";
import {
  runner,
  runnerId,
  runnerToday,
  seedPlan,
  seedPlanSessions,
  seededPlanInput,
  withDatabase,
} from "./seed";
import { seedRunOn, type SeededDayRun } from "./seed-adaptation";

// The weekly review's seeds (slice 10): one stored review of a Monday-to-Sunday week, as the weekly-review
// job stores it (writeWeeklyReview in apps/api/src/services/weekly-review.ts), with one change the engine
// made to the coming week's long run. One story, told on two calendars: the flows' on the real clock (the
// API answers GET /api/reviews/latest from the server's own today) and the capture's on seedPlan's.

/**
 * The reviewed week's runs, by days from its Monday: easy on Monday and Friday, the long run on Sunday,
 * and Wednesday's tempo not run. Easy at 6:40 /km, the long run at 6:50 /km.
 */
const reviewedWeekRuns: readonly (SeededDayRun & { day: number })[] = [
  { day: 0, distanceM: 3000, durationS: 1200 },
  { day: 4, distanceM: 3100, durationS: 1240 },
  { day: 6, distanceM: 14_200, durationS: 5822 },
];

/**
 * The reviewed week in numbers as the review stores them: seedPlan's week 1 (easy 2.9 km, tempo 6.5 km,
 * easy 2.9 km, long run 13.9 km), three of its four sessions run as reviewedWeekRuns.
 */
export const reviewedWeekSummary = {
  runs: 3,
  distanceM: 20_300,
  durationS: 8262,
  sessionsPlanned: 4,
  sessionsDone: 3,
  plannedDistanceM: 26_250,
  paused: false,
} as const satisfies ReviewWeekSummary;

/** The coach's card for that week, in its voice: what happened, what it means, the coming week. */
export const weeklyReviewCard = {
  headline: "3 of 4 sessions and 20.3 km, with Wednesday's tempo missed.",
  whatHappened:
    "Easy runs on Monday and Friday at 6:40 /km. Wednesday's tempo was not run. Sunday's long run went 14.2 km at 6:50 /km.",
  whatItMeans:
    "An even pace over 14.2 km means the long run sits within your aerobic range. One missed tempo costs little; making it up would cost more.",
  nextWeek:
    "Four runs: easy on Monday and Friday, intervals on Wednesday and the long run on Sunday. Leave the missed tempo out.",
} as const satisfies WeeklyReview;

/**
 * The coach's note on its one change, without the new numbers, which the card shows from the engine. The
 * week after the coming one is seedPlan's week 3, a down week, so the note does not promise it more.
 */
export const weeklyReviewNote =
  "Held near last week's long run while the missed session is behind you. The week after is a planned easier one.";

/** The change the review proposed for the coming week's long run, as the engine applied it. */
const longRunDelta = { kind: "scale", factor: 0.9 } as const satisfies PlanDelta;

/**
 * The coming week's sessions, by days from its Monday, as seedPlan's week 2 holds them: easy on Monday
 * and Friday, intervals on Wednesday, the long run on Sunday.
 */
const comingWeekSessions: readonly { day: number; type: SessionType }[] = [
  { day: 0, type: "easy" },
  { day: 2, type: "intervals" },
  { day: 4, type: "easy" },
  { day: 6, type: "long" },
];

/** A stored review as a spec checks it on screen. */
export type SeededWeeklyReview = {
  id: string;
  /** The reviewed week's Monday. */
  weekStart: string;
  /** The change the engine made to the coming week's long run, as the card's change line reads it. */
  change: PlanChange;
  /** The coming week's sessions as they stand after the change, by date: the review screen's preview. */
  comingWeek: ReviewSession[];
};

/** A coming-week session as storeWeeklyReview reads it. */
type StoredPlanSession = {
  id: string;
  date: string;
  type: SessionType;
  status: SessionStatus;
  title: string | null;
  target: SessionTarget;
  steps: SessionSteps;
};

function snapshotOf({ type, title, status, target }: AdjustedSession): SessionSnapshot {
  return { type, title, status, target };
}

/** Stores reviewedWeekRuns in the week from `reviewed`, a Monday. */
async function seedReviewedWeekRuns(reviewed: string): Promise<void> {
  for (const { day, ...run } of reviewedWeekRuns) await seedRunOn(addDays(reviewed, day), run);
}

/**
 * Stores the review of the week from `reviewed` (a Monday), as the weekly-review job writes it once that
 * week ended: the coach's card (weekly-review/v1, the model's, no thumb yet) with the
 * week's summary and its note keyed by the changed session's id, and in the same transaction the long run
 * of the coming week scaled by the engine's own applyDelta (source review, applied, with the session
 * before and after), as applyReviewChanges writes it. Seed the plan first: the coming week must hold its
 * long run.
 */
async function storeWeeklyReview(reviewed: string, writtenAt: string): Promise<SeededWeeklyReview> {
  return withDatabase(async (db) => {
    await db.query("begin");
    try {
      const plans = await db.query<{ id: string; paces: PlanPaces }>(
        `select id, paces from plan where user_id = ${runnerId} and status = 'active'`,
        [runner.email],
      );
      const plan = plans.rows[0];
      if (!plan) throw new Error("Seed a plan before its weekly review");
      // The coming week in the order the API lists it: by date, then id.
      const { rows: coming } = await db.query<StoredPlanSession>(
        `select id, date::text as date, type, status, title, target, steps from plan_session
         where user_id = ${runnerId} and plan_id = $2 and date between $3 and $4
         order by date, id`,
        [runner.email, plan.id, addDays(reviewed, 7), addDays(reviewed, 13)],
      );
      const longRun = coming.find((session) => session.type === "long");
      if (!longRun) throw new Error(`The week after ${reviewed} holds no long run`);
      const before: AdjustedSession = {
        type: longRun.type,
        title: longRun.title,
        status: longRun.status,
        steps: longRun.steps,
        target: longRun.target,
      };
      const after = applyDelta({ ...longRun, source: "plan" }, longRunDelta, plan.paces);

      const messages = await db.query<{ id: string }>(
        `insert into coach_message (user_id, kind, week_start, plan_id, prompt_version, model, content,
           usage, created_at, updated_at)
         values (${runnerId}, 'weekly_review', $2, $3, 'weekly-review/v1', 'claude-opus-5-5', $4::jsonb,
           $5::jsonb, $6, $6)
         returning id`,
        [
          runner.email,
          reviewed,
          plan.id,
          JSON.stringify({
            card: weeklyReviewCard,
            summary: reviewedWeekSummary,
            notes: { [longRun.id]: weeklyReviewNote },
          }),
          JSON.stringify({ inputTokens: 2140, outputTokens: 236 }),
          writtenAt,
        ],
      );
      const id = messages.rows[0]?.id;
      if (id === undefined) throw new Error("The weekly review insert returned nothing");

      await db.query(
        `update plan_session set type = $2, title = $3, status = $4, steps = $5::jsonb, target = $6::jsonb
         where id = $1`,
        [
          longRun.id,
          after.type,
          after.title,
          after.status,
          JSON.stringify(after.steps),
          JSON.stringify(after.target),
        ],
      );
      await db.query(
        `insert into plan_adjustment (user_id, plan_session_id, source, kind, outcome, requested, applied,
           before, after, coach_message_id, created_at, updated_at)
         values (${runnerId}, $2, 'review', $3, 'applied', $4::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7,
           $8, $8)`,
        [
          runner.email,
          longRun.id,
          longRunDelta.kind,
          JSON.stringify(longRunDelta),
          JSON.stringify(before),
          JSON.stringify(after),
          id,
          writtenAt,
        ],
      );
      await db.query("commit");

      return {
        id,
        weekStart: reviewed,
        change: {
          sessionId: longRun.id,
          date: longRun.date,
          kind: longRunDelta.kind,
          clamped: false,
          before: snapshotOf(before),
          after: snapshotOf(after),
        },
        comingWeek: coming.map((session) => {
          const now = session.id === longRun.id ? after : session;
          return {
            id: session.id,
            date: session.date,
            type: now.type,
            title: now.title,
            status: now.status,
            source: "plan",
            target: now.target,
          };
        }),
      };
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

/**
 * For flows on the real clock: last week (the last one that ended on the runner's today) with its runs,
 * and a plan moved to start on this week's Monday (seedPlanSessions) holding the coming week's four
 * sessions on seedPlan's week 2 days. No review: the state before the coach wrote one, or when it never
 * does. Returns last week's Monday.
 */
export async function seedLastWeek(): Promise<string> {
  const thisMonday = weekStart(runnerToday());
  await seedPlanSessions(
    comingWeekSessions.map(({ day, type }) => ({ date: addDays(thisMonday, day), type })),
  );
  const reviewed = addDays(thisMonday, -7);
  await seedReviewedWeekRuns(reviewed);
  return reviewed;
}

/**
 * seedLastWeek with the coach's review of that week, written at 03:32 UTC on this week's Monday, after
 * the daily sync: the review Today shows (GET /api/reviews/latest answers ready) until Sunday.
 */
export async function seedLastWeekReview(): Promise<SeededWeeklyReview> {
  const reviewed = await seedLastWeek();
  return storeWeeklyReview(reviewed, `${addDays(reviewed, 7)}T03:32:00Z`);
}

/**
 * The instant the review screen's capture pins the browser clock to: Mon 12 Oct 2026, 07:00, the morning
 * after seedPlan's week 1 ended, once the review written at 03:32 is in. Its week then reads without a
 * year, and nothing of the coming week is past.
 */
export const weekOneReviewAt = new Date("2026-10-12T07:00:00Z");

/**
 * For the capture, whatever the date: seedPlan's plan and the coach's review of its week 1 (5–11 Oct
 * 2026), whose coming week is week 2 (12–18 Oct) with its long run scaled.
 */
export async function seedWeekOneReview(): Promise<SeededWeeklyReview> {
  await seedPlan();
  await seedReviewedWeekRuns(seededPlanInput.startDate);
  return storeWeeklyReview(seededPlanInput.startDate, "2026-10-12T03:32:00Z");
}
