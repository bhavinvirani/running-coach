import type { SessionStatus } from "@running-coach/shared";
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { type Db, type DbTransaction } from "../db/client";
import {
  plan,
  type PlanRow,
  trainingPause,
  type TrainingPauseRow,
  userSettings,
} from "../db/schema";
import { addDays, localDateOf } from "../lib/local-date";

// What the adaptation services (session-match, pause, re-entry, coach-change, review-change) read about the
// runner before they change sessions: the local today, the open pause, the pauses a week had and the
// active plan.

export type Executor = Db | DbTransaction;

/** The runner's local date at `now`, in the time zone of their settings. */
export async function runnerToday(executor: Executor, userId: string, now: Date): Promise<string> {
  const [row] = await executor
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  // Every user gets its settings row at creation.
  if (!row) throw new Error("The user has no settings row");
  return localDateOf(now, row.timezone);
}

/** The runner's open pause (at most one: training_pause_user_id_open_idx), null while training runs. */
export async function openPause(
  executor: Executor,
  userId: string,
): Promise<TrainingPauseRow | null> {
  const [row] = await executor
    .select()
    .from(trainingPause)
    .where(and(eq(trainingPause.userId, userId), isNull(trainingPause.endedOn)));
  return row ?? null;
}

/**
 * The latest pause that held a day of the Monday-to-Sunday week from `monday`: its paused days are
 * started_on up to the day before ended_on (the first day back), so one that started and ended on the
 * same day held none. An open pause holds every day from its start. Local dates only, so DST never moves
 * a week's edge. Null when no pause held a day of it.
 */
export async function pauseCovering(
  executor: Executor,
  userId: string,
  monday: string,
): Promise<TrainingPauseRow | null> {
  const [row] = await executor
    .select()
    .from(trainingPause)
    .where(
      and(
        eq(trainingPause.userId, userId),
        lte(trainingPause.startedOn, addDays(monday, 6)),
        or(
          isNull(trainingPause.endedOn),
          and(
            gt(trainingPause.endedOn, monday),
            gt(trainingPause.endedOn, trainingPause.startedOn),
          ),
        ),
      ),
    )
    .orderBy(desc(trainingPause.startedOn), desc(trainingPause.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The runner's active plan. `lock` takes its row FOR UPDATE: the re-entries take it first, so two of them
 * for one runner (a sync's gap and "I'm back", or two processes) run one after the other, and a goal save
 * waits for them.
 */
export async function activePlan(
  executor: Executor,
  userId: string,
  { lock = false }: { lock?: boolean } = {},
): Promise<PlanRow | null> {
  const query = executor
    .select()
    .from(plan)
    .where(and(eq(plan.userId, userId), eq(plan.status, "active")));
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

/** A session is paused from the open pause's start on while it is still to run (planned or moved). */
export function isPaused(
  session: { date: string; status: SessionStatus },
  pausedFrom: string | null,
): boolean {
  return (
    pausedFrom !== null &&
    session.date >= pausedFrom &&
    (session.status === "planned" || session.status === "moved")
  );
}
