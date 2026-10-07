import {
  baselineReEntryFactor,
  RE_ENTRY_SHORT_BREAK_DAYS,
  reEntryFactor,
  reEntryPlan,
} from "@running-coach/engine";
import type { ReEntry } from "@running-coach/shared";
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
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
import { runDate } from "./run-dates";
import { activePlan, runnerToday } from "./runner-state";
import { adjustedOf } from "./session-view";

// The plan eased for a return after time off (SPEC: Plan engine): when the runner ends a pause ("I'm back",
// pause.ts) and when a synced run ends 7 or more days without one (gap below). The engine's reEntryPlan
// decides every number; this writes each changed session in place and logs it in plan_adjustment, whose
// unique indexes make a second run for the same pause or run a no-op.

const log = logger.child({ module: "re-entry" });

/**
 * True when the active plan already starts from the re-entry this break calls for: it was built after the
 * last run before the break (none counts as after), from a baseline whose re-entry factor is no higher
 * than the break's. Easing it again would cut the return twice.
 */
export function planCarriesReEntry(
  active: Pick<PlanRow, "createdAt" | "inputs">,
  lastRunStart: Date | null,
  daysOff: number,
): boolean {
  return (
    (lastRunStart === null || active.createdAt > lastRunStart) &&
    baselineReEntryFactor(active.inputs.baseline) <= reEntryFactor(daysOff)
  );
}

export interface WriteReEntryInput {
  userId: string;
  /** Taken FOR UPDATE by the caller (activePlan with lock), which serializes re-entries per runner. */
  active: PlanRow;
  /** The first day back. */
  fromDate: string;
  /** Days from the last run to the return, as measured. */
  daysOff: number;
  /** What the engine is given: 0 when the plan already carries the re-entry (planCarriesReEntry). */
  engineDaysOff: number;
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
    daysOff: input.engineDaysOff,
    walkRun,
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
  const applied: ReEntryRequest = { factor: result.factor, walkRun, daysOff: input.engineDaysOff };
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

/**
 * After a sync: eases the plan when the newest run it inserted (R, by UTC start) ends 7 or more days
 * without a run, counted in local dates from the run before it (P). Nothing when R is not the runner's
 * newest run (a late upload of an old run ends no break today), when there is no P, when the gap is
 * shorter, when a pause overlaps it ("I'm back" eased that return), when R already eased the plan, when
 * there is no active plan, or when the plan was built after P from a baseline that already carries this
 * re-entry. The return starts the day after R, or today when that is later. Only syncs call it: the
 * history import's runs end no break today. Returns what it applied, null when it eased nothing.
 */
export async function gapReEntry(
  userId: string,
  insertedIds: readonly string[],
  now = new Date(),
): Promise<Pick<ReEntry, "factor" | "daysOff" | "fromDate" | "sessionsChanged"> | null> {
  if (insertedIds.length === 0) return null;
  const today = await runnerToday(db, userId, now);
  return db.transaction(async (tx) => {
    const active = await activePlan(tx, userId, { lock: true });
    if (!active) return null;
    const runColumns = { id: activity.id, startUtc: activity.startUtc, date: runDate };
    const newestFirst = [desc(activity.startUtc), desc(activity.id)];
    const [newest] = await tx
      .select(runColumns)
      .from(activity)
      .where(and(eq(activity.userId, userId), inArray(activity.id, [...insertedIds])))
      .orderBy(...newestFirst)
      .limit(1);
    if (!newest) return null;
    const [later] = await tx
      .select({ id: activity.id })
      .from(activity)
      .where(and(eq(activity.userId, userId), gt(activity.startUtc, newest.startUtc)))
      .limit(1);
    if (later) return null;
    const [previous] = await tx
      .select(runColumns)
      .from(activity)
      .where(and(eq(activity.userId, userId), lt(activity.startUtc, newest.startUtc)))
      .orderBy(...newestFirst)
      .limit(1);
    if (!previous) return null;
    const gap = daysBetween(previous.date, newest.date);
    if (gap < RE_ENTRY_SHORT_BREAK_DAYS) return null;

    const [pause] = await tx
      .select({ id: trainingPause.id })
      .from(trainingPause)
      .where(
        and(
          eq(trainingPause.userId, userId),
          lte(trainingPause.startedOn, newest.date),
          or(isNull(trainingPause.endedOn), gte(trainingPause.endedOn, previous.date)),
        ),
      )
      .limit(1);
    if (pause) return null;
    // Checked under the plan's lock: a second sync for the same run waits for the first and stops here.
    const [eased] = await tx
      .select({ id: planAdjustment.id })
      .from(planAdjustment)
      .where(and(eq(planAdjustment.activityId, newest.id), eq(planAdjustment.source, "gap")))
      .limit(1);
    if (eased) return null;
    if (planCarriesReEntry(active, previous.startUtc, gap)) return null;

    const dayAfter = addDays(newest.date, 1);
    const fromDate = dayAfter > today ? dayAfter : today;
    const { factor, sessionsChanged } = await writeReEntry(tx, {
      userId,
      active,
      fromDate,
      daysOff: gap,
      engineDaysOff: gap,
      walkRun: false,
      source: { kind: "gap", activityId: newest.id },
    });
    log.info(
      { userId, activityId: newest.id, daysOff: gap, factor, fromDate, sessionsChanged },
      "plan eased after a gap without runs",
    );
    return { factor, daysOff: gap, fromDate, sessionsChanged };
  });
}
