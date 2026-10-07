import {
  baselineReEntryFactor,
  RE_ENTRY_SHORT_BREAK_DAYS,
  reEnteredVolumeM,
  reEntryFactor,
  reEntryPlan,
} from "@running-coach/engine";
import type { ReEntry } from "@running-coach/shared";
import { and, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { type DbTransaction, db } from "../db/client";
import {
  activity,
  planAdjustment,
  type PlanRow,
  planSession,
  type ReEntryRequest,
  trainingPause,
} from "../db/schema";
import { addDays, daysBetween, mondayOf } from "../lib/local-date";
import { logger } from "../lib/logger";
import { runDate, runDateWithin } from "./run-dates";
import { activePlan, openPause, runnerToday } from "./runner-state";
import { adjustedOf } from "./session-view";

// The plan eased for a return after time off (SPEC: Plan engine): when the runner ends a pause ("I'm back",
// pause.ts) and when a synced run ends 7 or more days without one (gap below). The engine's reEntryPlan
// decides every number; this writes each changed session in place and logs it in plan_adjustment, whose
// unique indexes make a second run for the same pause or run a no-op.

const log = logger.child({ module: "re-entry" });

/** A plan's first week: the days from its start date that its baseline's re-entry eases. */
const PLAN_FIRST_WEEK_DAYS = 7;

/** Each sync looks this many local dates back, today included, for a run that ended a gap. */
export const GAP_RE_ENTRY_WINDOW_DAYS = 7;

/**
 * The share of volume the active plan already eases this return by, for reEntryPlan's carriedFactor: the
 * re-entry factor of its baseline when it was built during the break (after `breakStart`, the run or the
 * pause that began it) and the return falls in or before its first week, which carries that easing; else
 * 1. A plan built before the break, or a return after its first week, carries nothing, and neither does a
 * plan that starts at the floor: with no volume left after re-entry (no runs, or only empty baseline
 * weeks) the engine starts week 1 at the distance's floor, not at an eased share.
 */
export function carriedFactor(
  active: Pick<PlanRow, "createdAt" | "inputs" | "startDate">,
  breakStart: Date,
  returnDate: string,
): number {
  const builtDuringBreak = active.createdAt > breakStart;
  const inFirstWeek = daysBetween(active.startDate, returnDate) < PLAN_FIRST_WEEK_DAYS;
  if (!builtDuringBreak || !inFirstWeek) return 1;
  if (reEnteredVolumeM(active.inputs.baseline) === 0) return 1;
  return baselineReEntryFactor(active.inputs.baseline);
}

export interface WriteReEntryInput {
  userId: string;
  /** Taken FOR UPDATE by the caller (activePlan with lock), which serializes re-entries per runner. */
  active: PlanRow;
  /** The first day back. */
  fromDate: string;
  /** The longest stretch without a run that the return follows, in days. */
  daysOff: number;
  /** What the plan's first week already eases this return by (carriedFactor), 1 for nothing. */
  carriedFactor: number;
  walkRun: boolean;
  /** pause: "I'm back" for pauseId; gap: the run activityId ended the gap. */
  source: { kind: "pause"; pauseId: string } | { kind: "gap"; activityId: string };
}

/**
 * Runs reEntryPlan over the active plan's sessions and the custom workouts from the first day back's week
 * on, locked, and writes each change: the log row first, ON CONFLICT DO NOTHING on the source's unique
 * index, then the session only when the row is new, so a retry or a second process changes nothing twice.
 * Returns the factor the first week runs at and the number of sessions changed.
 */
export async function writeReEntry(
  tx: DbTransaction,
  input: WriteReEntryInput,
): Promise<{ factor: number; sessionsChanged: number }> {
  const { userId, active, fromDate, walkRun, source } = input;
  const sessions = await tx
    .select()
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        or(eq(planSession.planId, active.id), isNull(planSession.planId)),
        gte(planSession.date, mondayOf(fromDate)),
      ),
    )
    .for("update");
  const result = reEntryPlan({
    fromDate,
    daysOff: input.daysOff,
    walkRun,
    carriedFactor: input.carriedFactor,
    sessions: sessions.map((row) => ({
      ...adjustedOf(row),
      id: row.id,
      date: row.date,
      source: row.planId === null ? ("custom" as const) : ("plan" as const),
    })),
    paces: active.paces,
  });
  const requested: ReEntryRequest = {
    factor: reEntryFactor(input.daysOff),
    walkRun,
    daysOff: input.daysOff,
  };
  const applied: ReEntryRequest = { factor: result.factor, walkRun, daysOff: input.daysOff };
  const byId = new Map(sessions.map((row) => [row.id, row]));
  let sessionsChanged = 0;
  for (const change of result.changes) {
    const row = byId.get(change.id)!;
    const logged = await tx
      .insert(planAdjustment)
      .values({
        userId,
        planSessionId: row.id,
        source: source.kind,
        kind: "re_entry",
        outcome: "applied",
        requested,
        applied,
        before: adjustedOf(row),
        after: change.session,
        ...(source.kind === "pause"
          ? { pauseId: source.pauseId }
          : { activityId: source.activityId }),
      })
      .onConflictDoNothing(
        source.kind === "pause"
          ? {
              target: [planAdjustment.pauseId, planAdjustment.planSessionId],
              where: sql`${planAdjustment.source} = 'pause'`,
            }
          : {
              target: [planAdjustment.activityId, planAdjustment.planSessionId],
              where: sql`${planAdjustment.source} = 'gap'`,
            },
      )
      .returning({ id: planAdjustment.id });
    if (logged.length === 0) continue;
    const { type, title, status, steps, target } = change.session;
    const updated = await tx
      .update(planSession)
      .set({ type, title, status, steps, target })
      .where(
        and(
          eq(planSession.id, row.id),
          eq(planSession.status, row.status),
          eq(planSession.date, row.date),
        ),
      )
      .returning({ id: planSession.id });
    // The row is locked since it was read, so nothing can have changed it.
    if (updated.length === 0) throw new Error(`Session ${row.id} changed under its lock`);
    sessionsChanged += 1;
  }
  return { factor: result.factor, sessionsChanged };
}

type RunMark = { id: string; startUtc: Date; date: string; storedAt: Date };

/**
 * The newest run R of the last GAP_RE_ENTRY_WINDOW_DAYS local dates, today included, that ends 7 or more
 * days without a run, counted in local dates from the run before it by UTC start (P, any date), with P;
 * null when there is none.
 */
async function newestGapEnd(
  tx: DbTransaction,
  userId: string,
  today: string,
): Promise<{ run: RunMark; previous: RunMark } | null> {
  const runColumns = {
    id: activity.id,
    startUtc: activity.startUtc,
    date: runDate,
    storedAt: activity.createdAt,
  };
  const newestFirst = [desc(activity.startUtc), desc(activity.id)];
  const candidates = await tx
    .select(runColumns)
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        runDateWithin(addDays(today, 1 - GAP_RE_ENTRY_WINDOW_DAYS), today),
      ),
    )
    .orderBy(...newestFirst);
  for (const run of candidates) {
    const [previous] = await tx
      .select(runColumns)
      .from(activity)
      .where(and(eq(activity.userId, userId), lt(activity.startUtc, run.startUtc)))
      .orderBy(...newestFirst)
      .limit(1);
    // The runner's first run ends no break, and neither does any older candidate.
    if (!previous) return null;
    if (daysBetween(previous.date, run.date) >= RE_ENTRY_SHORT_BREAK_DAYS) return { run, previous };
  }
  return null;
}

/**
 * After every sync, whatever it inserted: eases the plan when a run of the last 7 local dates (R, the
 * newest such) ends 7 or more days without a run, counted in local dates from the run before it (P). A
 * sync that failed to ease is retried by the next one, since each one looks at the same days again.
 * Nothing when the plan was already eased for this break (a gap row created since P started, also when
 * an older run of the comeback is uploaded late, but not one for a run before P), during an open pause
 * ("I'm back" will measure the break), when a pause that held R's date ended on or after it ("I'm back"
 * counted R), when a pause that started after P's date ended on or after R's before R was stored ("I'm
 * back" measured across R's date, which was uploaded late), or without an active plan. A pause that ended
 * after P's date and before R's starts the break at its ended_on instead, which must still leave 7 days.
 * A plan built during the break eases by what its first week does not carry yet (carriedFactor). The
 * return starts the day after R, or today when that is later; the rows are keyed on R. Only syncs call
 * it: the history import ends no break today. Returns what it applied, null when it eased nothing.
 */
export async function gapReEntry(
  userId: string,
  now = new Date(),
): Promise<Pick<ReEntry, "factor" | "daysOff" | "fromDate" | "sessionsChanged"> | null> {
  const today = await runnerToday(db, userId, now);
  return db.transaction(async (tx) => {
    // The plan's lock serializes this with "I'm back" and with a second sync for the same run.
    const active = await activePlan(tx, userId, { lock: true });
    if (!active) return null;
    if (await openPause(tx, userId)) return null;
    const found = await newestGapEnd(tx, userId, today);
    if (!found) return null;
    const { run, previous } = found;

    const [eased] = await tx
      .select({ id: planAdjustment.id })
      .from(planAdjustment)
      .leftJoin(activity, eq(activity.id, planAdjustment.activityId))
      .where(
        and(
          eq(planAdjustment.userId, userId),
          eq(planAdjustment.source, "gap"),
          gte(planAdjustment.createdAt, previous.startUtc),
          // A run deleted since keeps its rows unlinked: they still count.
          or(isNull(activity.id), gt(activity.startUtc, previous.startUtc)),
        ),
      )
      .limit(1);
    if (eased) return null;

    // "I'm back" counted R's date when its pause held it, or when the pause started after P's date and
    // was ended before R was stored (a late upload): it measured from P across R's date without R.
    const [countedRun] = await tx
      .select({ id: trainingPause.id })
      .from(trainingPause)
      .where(
        and(
          eq(trainingPause.userId, userId),
          gte(trainingPause.endedOn, run.date),
          or(
            lte(trainingPause.startedOn, run.date),
            and(
              gt(trainingPause.startedOn, previous.date),
              lt(trainingPause.updatedAt, run.storedAt),
            ),
          ),
        ),
      )
      .limit(1);
    if (countedRun) return null;
    // The latest "I'm back" between P's date and R's: the break since then is the one this run ends.
    const [ended] = await tx
      .select({ endedOn: trainingPause.endedOn, updatedAt: trainingPause.updatedAt })
      .from(trainingPause)
      .where(
        and(
          eq(trainingPause.userId, userId),
          gt(trainingPause.endedOn, previous.date),
          lt(trainingPause.endedOn, run.date),
        ),
      )
      .orderBy(desc(trainingPause.endedOn))
      .limit(1);
    const breakFrom = ended?.endedOn ?? previous.date;
    // ended_on is written once, by "I'm back", which stamps updated_at with the moment it was tapped.
    const breakStart = ended ? ended.updatedAt : previous.startUtc;
    const daysOff = daysBetween(breakFrom, run.date);
    if (daysOff < RE_ENTRY_SHORT_BREAK_DAYS) return null;

    const dayAfter = addDays(run.date, 1);
    const fromDate = dayAfter > today ? dayAfter : today;
    const { factor, sessionsChanged } = await writeReEntry(tx, {
      userId,
      active,
      fromDate,
      daysOff,
      carriedFactor: carriedFactor(active, breakStart, fromDate),
      walkRun: false,
      source: { kind: "gap", activityId: run.id },
    });
    log.info(
      { userId, activityId: run.id, daysOff, factor, fromDate, sessionsChanged },
      "plan eased after a gap without runs",
    );
    return { factor, daysOff, fromDate, sessionsChanged };
  });
}
