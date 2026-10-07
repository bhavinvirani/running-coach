import { matchSessions } from "@running-coach/engine";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../db/client";
import { activity, planSession } from "../db/schema";
import { logger } from "../lib/logger";
import { runDate, runDateWithin } from "./run-dates";
import { activePlan, type Executor, openPause, runnerToday } from "./runner-state";

// Which sessions the runner's runs completed (SPEC: Plan engine, slice 9): after every sync and when a
// pause ends. Recomputed from scratch over the past each time, so a run deleted or edited on Garmin moves
// its done mark with it; the engine's matchSessions decides, this writes what it changed.

const log = logger.child({ module: "session-match" });

/**
 * Matches the active plan's sessions and the custom workouts dated up to `today` with the runs on their
 * local dates (start_local, so the day the runner lived; indoor and manual runs count), from the earliest
 * such session on. `pausedFrom` is the open pause's start: sessions from it on are not missed yet. Each
 * change is written only while the session still has the status and date it was read with, so a move or
 * a skip that lands meanwhile wins. Returns the number of sessions changed.
 */
export async function matchSessionsUpTo(
  executor: Executor,
  userId: string,
  today: string,
  pausedFrom: string | null,
): Promise<number> {
  const active = await activePlan(executor, userId);
  const sessions = await executor
    .select({
      id: planSession.id,
      date: planSession.date,
      status: planSession.status,
      target: planSession.target,
      activityId: planSession.activityId,
    })
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        lte(planSession.date, today),
        active
          ? or(eq(planSession.planId, active.id), isNull(planSession.planId))
          : isNull(planSession.planId),
      ),
    );
  if (sessions.length === 0) return 0;
  const from = sessions.reduce((earliest, s) => (s.date < earliest ? s.date : earliest), today);
  const runs = await executor
    .select({ id: activity.id, date: runDate, distanceM: activity.distanceM })
    .from(activity)
    .where(and(eq(activity.userId, userId), runDateWithin(from, today)));

  const read = new Map(sessions.map((session) => [session.id, session]));
  const changes = matchSessions({
    today,
    sessions: sessions.map((session) => ({ ...session, distanceM: session.target.distanceM })),
    runs,
    pausedFrom,
  });
  let changed = 0;
  for (const change of changes) {
    const was = read.get(change.id)!;
    const updated = await executor
      .update(planSession)
      .set({ status: change.status, activityId: change.activityId })
      .where(
        and(
          eq(planSession.id, change.id),
          eq(planSession.status, was.status),
          eq(planSession.date, was.date),
        ),
      )
      .returning({ id: planSession.id });
    changed += updated.length;
  }
  if (changes.length > 0) {
    log.info({ userId, today, changes: changes.length, changed }, "sessions matched with runs");
  }
  return changed;
}

/**
 * After a sync: matches the runner's sessions up to their local today at `now` with their runs, the open
 * pause holding its sessions. Returns the number of sessions changed.
 */
export async function matchPlanSessions(userId: string, now = new Date()): Promise<number> {
  const today = await runnerToday(db, userId, now);
  const pause = await openPause(db, userId);
  return matchSessionsUpTo(db, userId, today, pause?.startedOn ?? null);
}
