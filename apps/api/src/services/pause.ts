import { reEntryFactor } from "@running-coach/engine";
import type {
  EndPauseResponse,
  PauseReason,
  PauseResponse,
  ReEntry,
  TrainingPause,
} from "@running-coach/shared";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { type DbTransaction, db } from "../db/client";
import {
  activity,
  planAdjustment,
  planSession,
  trainingPause,
  type TrainingPauseRow,
} from "../db/schema";
import { daysBetween } from "../lib/local-date";
import { logger } from "../lib/logger";
import { planCarriesReEntry, writeReEntry } from "./re-entry";
import { runDate, runDateUpTo } from "./run-dates";
import { activePlan, openPause, runnerToday } from "./runner-state";
import { matchSessionsUpTo } from "./session-match";
import { adjustedOf } from "./session-view";
import { queueWorkoutPush } from "./workout-push";

// "Not feeling 100%" (SPEC: Plan engine, slice 9): a pause from today holds the runner's sessions (they read
// paused and leave the watch) until "I'm back", which skips the ones left in it and eases the return. The
// pause belongs to the runner, not to a plan: a goal saved meanwhile keeps it.

const log = logger.child({ module: "pause" });

function toTrainingPause(row: TrainingPauseRow): TrainingPause {
  return {
    id: row.id,
    reason: row.reason,
    startDate: row.startedOn,
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /api/pause: the open pause, null while training runs. */
export async function getPause(userId: string): Promise<PauseResponse> {
  const row = await openPause(db, userId);
  return { pause: row ? toTrainingPause(row) : null };
}

/**
 * POST /api/pause: a pause from the runner's today at `now`. With one open already it answers that one
 * unchanged (a double tap opens one: the insert does nothing on the open index). A new pause queues a
 * workout push, which takes its sessions off the watch.
 */
export async function startPause(
  userId: string,
  reason: PauseReason,
  now = new Date(),
): Promise<PauseResponse> {
  const today = await runnerToday(db, userId, now);
  const inserted = await db
    .insert(trainingPause)
    .values({ userId, reason, startedOn: today })
    .onConflictDoNothing({
      target: trainingPause.userId,
      where: sql`${trainingPause.endedOn} is null`,
    })
    .returning({ id: trainingPause.id });
  const row = await openPause(db, userId);
  if (inserted.length > 0) {
    // Never the reason: whether the runner is ill or injured is health data.
    log.info({ userId, pauseId: inserted[0]!.id, startedOn: today }, "training paused");
    await queueWorkoutPush(userId);
  }
  // Null only when an "I'm back" closed it between the two statements.
  return { pause: row ? toTrainingPause(row) : null };
}

/**
 * Skips the sessions the pause held that "I'm back" leaves behind: the active plan's and the custom ones
 * from its start to before today still planned or moved, never made up. Each is logged (source pause,
 * kind rest). Returns how many.
 */
async function skipPausedSessions(
  tx: DbTransaction,
  userId: string,
  activePlanId: string | null,
  pause: TrainingPauseRow,
  today: string,
): Promise<number> {
  const rows = await tx
    .select()
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        activePlanId === null
          ? isNull(planSession.planId)
          : or(eq(planSession.planId, activePlanId), isNull(planSession.planId)),
        gte(planSession.date, pause.startedOn),
        lt(planSession.date, today),
        inArray(planSession.status, ["planned", "moved"]),
      ),
    )
    .for("update");
  for (const row of rows) {
    await tx
      .update(planSession)
      .set({ status: "skipped" })
      .where(and(eq(planSession.id, row.id), eq(planSession.status, row.status)));
    await tx
      .insert(planAdjustment)
      .values({
        userId,
        planSessionId: row.id,
        source: "pause",
        kind: "rest",
        outcome: "applied",
        requested: { kind: "rest" },
        applied: { kind: "rest" },
        before: adjustedOf(row),
        after: { ...adjustedOf(row), status: "skipped" },
        pauseId: pause.id,
      })
      .onConflictDoNothing({
        target: [planAdjustment.pauseId, planAdjustment.planSessionId],
        where: sql`${planAdjustment.source} = 'pause'`,
      });
  }
  return rows.length;
}

/**
 * POST /api/pause/end ("I'm back"), in one transaction. Closes the open pause today (none open: reEntry
 * null, so a second tap changes nothing); matches runs first, so a run during the pause marks its
 * session done; skips the sessions left in the pause; then eases the return from today by the days since
 * the last run on or before today (from the pause's start without any run), walk-run after illness or
 * injury. A plan built after that run whose baseline already carries the re-entry gets walk-run only
 * (daysOff 0 to the engine), so the return is never cut twice. Without an active plan the pause still
 * ends, with nothing to ease. Queues a workout push after the commit.
 */
export async function endPause(userId: string, now = new Date()): Promise<EndPauseResponse> {
  const today = await runnerToday(db, userId, now);
  const ended = await db.transaction(async (tx) => {
    const [pause] = await tx
      .update(trainingPause)
      // The check keeps ended_on on or after started_on, also for a runner who moved west since.
      .set({ endedOn: sql`greatest(${today}::date, ${trainingPause.startedOn})` })
      .where(and(eq(trainingPause.userId, userId), isNull(trainingPause.endedOn)))
      .returning();
    if (!pause) return null;
    const active = await activePlan(tx, userId, { lock: true });
    await matchSessionsUpTo(tx, userId, today, pause.startedOn);
    const skipped = await skipPausedSessions(tx, userId, active?.id ?? null, pause, today);

    const [lastRun] = await tx
      .select({ startUtc: activity.startUtc, date: runDate })
      .from(activity)
      .where(and(eq(activity.userId, userId), runDateUpTo(today)))
      .orderBy(desc(activity.startLocal), desc(activity.id))
      .limit(1);
    const daysOff = Math.max(0, daysBetween(lastRun?.date ?? pause.startedOn, today));
    const walkRun = pause.reason !== "break";
    let reEntry: ReEntry = {
      daysOff,
      factor: reEntryFactor(daysOff),
      walkRun,
      fromDate: today,
      sessionsChanged: 0,
    };
    if (active) {
      const carried = planCarriesReEntry(active, lastRun?.startUtc ?? null, daysOff);
      const written = await writeReEntry(tx, {
        userId,
        active,
        fromDate: today,
        daysOff,
        engineDaysOff: carried ? 0 : daysOff,
        walkRun,
        source: { kind: "pause", pauseId: pause.id },
      });
      reEntry = { ...reEntry, factor: written.factor, sessionsChanged: written.sessionsChanged };
    }
    // Not walkRun: it tells illness or injury from a break.
    const { daysOff: off, factor, sessionsChanged } = reEntry;
    log.info(
      { userId, pauseId: pause.id, skipped, daysOff: off, factor, sessionsChanged },
      "training pause ended",
    );
    return reEntry;
  });
  if (!ended) return { pause: null, reEntry: null };
  await queueWorkoutPush(userId);
  return { pause: null, reEntry: ended };
}
