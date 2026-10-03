import {
  ErrorCode,
  GARMIN_WORKOUT_BATCH_MAX,
  type GarminCalendarEntry,
  type GarminPushResponse,
  type GarminPushStatus,
  type GarminWorkoutAction,
  type GarminWorkoutSyncResponse,
  type OtherGarminWorkout,
} from "@running-coach/shared";
import { and, asc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { garminConnection, plan, planSession, userSettings } from "../db/schema";
import { garminClient, workoutStopError } from "../garmin/client";
import { enqueuePushWorkouts, isPushing } from "../jobs/push-workouts-queue";
import { DomainError } from "../lib/errors";
import { localDateOf } from "../lib/local-date";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";
import {
  type GarminAccount,
  openGarminAccount,
  recordGarminSuccess,
  requireGarminConnection,
} from "./garmin-account";
import {
  garminColumnsAfter,
  inWindow,
  type PlannedAction,
  planWorkoutPush,
  type PushSession,
  type PushWindow,
  pushWindow,
} from "./workout-push-plan";

// Keeps today and the next six days of the runner's calendar on Garmin (SPEC: Garmin calendar), from the
// push-workouts job, and takes third-party workouts off it on request. Writes on Garmin are not idempotent,
// so every result is stored the moment it comes back, before anything can throw: a retry then sends only
// what is still missing.

const log = logger.child({ module: "workout-push" });

/**
 * The push's own bookkeeping on garmin_connection leaves updated_at alone: it marks a Garmin 429 there
 * (rateLimitSecondsLeft in garmin-account.ts), and a push refused during that hour would otherwise restart
 * it on every try. Only Garmin outcomes (garmin-account.ts) move it.
 */
const keepUpdatedAt = { updatedAt: sql`${garminConnection.updatedAt}` };

/**
 * Batches per push. A week's changes fit in two or three (remove and create for each session at most);
 * the cap only ends a push that keeps finding work, as a workout Garmin keeps losing would.
 */
export const MAX_PUSH_ROUNDS = 5;

/** A session status the push may still change on Garmin. */
const PUSHABLE_STATUSES = ["planned", "moved", "skipped"] as const;

async function readPushState(userId: string, window: PushWindow) {
  const [settings] = await db
    .select({ units: userSettings.units })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  if (!settings) throw new Error("The user has no settings row");
  const [active] = await db
    .select({ id: plan.id, paces: plan.paces })
    .from(plan)
    .where(and(eq(plan.userId, userId), eq(plan.status, "active")));
  const sessions: PushSession[] = await db
    .select({
      id: planSession.id,
      planId: planSession.planId,
      date: planSession.date,
      type: planSession.type,
      title: planSession.title,
      target: planSession.target,
      steps: planSession.steps,
      status: planSession.status,
      garminWorkoutId: planSession.garminWorkoutId,
      garminScheduleId: planSession.garminScheduleId,
      garminDate: planSession.garminDate,
      garminHash: planSession.garminHash,
    })
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        or(
          and(gte(planSession.date, window.start), lte(planSession.date, window.end)),
          and(
            isNotNull(planSession.garminWorkoutId),
            inArray(planSession.status, [...PUSHABLE_STATUSES]),
            sql`coalesce(${planSession.garminDate}, ${planSession.date}) >= ${window.start}`,
          ),
        ),
      ),
    )
    .orderBy(asc(planSession.date), asc(planSession.id));
  return { units: settings.units, activePlan: active ?? null, sessions };
}

/** Stores what each result says Garmin now holds for its session, all in one transaction. */
async function recordResults(
  userId: string,
  batch: readonly PlannedAction[],
  response: GarminWorkoutSyncResponse,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, planned] of batch.entries()) {
      const result = response.results[index];
      // The service answers one result per action in request order (garminWorkoutSyncResponseSchema).
      if (result?.ref !== planned.action.ref || result.action !== planned.action.action) {
        throw new Error("The Garmin service answered workout results out of order");
      }
      const columns = garminColumnsAfter(planned, result);
      if (columns === null) continue;
      await tx
        .update(planSession)
        .set(columns)
        .where(and(eq(planSession.id, planned.session.id), eq(planSession.userId, userId)));
    }
  });
}

/**
 * The stop's code, or internal for anything that is not a DomainError, as the push status shows it. Also
 * runs for a refusal during a 429's hour, which must not move the hour's start.
 */
async function recordPushError(userId: string, error: unknown): Promise<void> {
  const code = error instanceof DomainError ? error.code : ErrorCode.internal;
  await db
    .update(garminConnection)
    .set({ workoutsPushError: code, ...keepUpdatedAt })
    .where(eq(garminConnection.userId, userId));
}

/**
 * One POST /workouts/sync through the account. `onResults` stores the results before a stop throws, inside
 * account.call, so the failure is recorded on the connection as any Garmin failure is (a 429's hour, the
 * expired-login count). A batch that ran through marks the login working. `readCalendar` asks for the
 * window's calendar after the actions.
 */
async function sendBatch(
  account: GarminAccount,
  userId: string,
  { window, readCalendar }: { window: PushWindow; readCalendar: boolean },
  actions: GarminWorkoutAction[],
  onResults: (response: GarminWorkoutSyncResponse) => Promise<void>,
): Promise<GarminWorkoutSyncResponse> {
  const response = await account.call(async (tokenBundle, options) => {
    const answer = await garminClient.syncWorkouts(
      {
        tokenBundle,
        actions,
        calendarStart: window.start,
        calendarEnd: window.end,
        readCalendar,
      },
      options,
    );
    await onResults(answer);
    if (answer.stopped) throw workoutStopError(answer.stopped);
    return answer;
  });
  await recordGarminSuccess(db, userId);
  return response;
}

/** Garmin ids of every workout the app holds for the runner, as stored (text). */
async function ownWorkoutIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: planSession.garminWorkoutId })
    .from(planSession)
    .where(and(eq(planSession.userId, userId), isNotNull(planSession.garminWorkoutId)));
  return new Set(rows.map((row) => row.id!));
}

/** The calendar's workouts in the window that the app did not create, in date order. */
function othersIn(
  calendar: readonly GarminCalendarEntry[],
  window: PushWindow,
  own: ReadonlySet<string>,
): OtherGarminWorkout[] {
  return calendar
    .filter((entry) => inWindow(entry.date, window) && !own.has(String(entry.workoutId)))
    .map(({ scheduleId, date, title }) => ({ scheduleId, date, title }))
    .toSorted((a, b) => a.date.localeCompare(b.date) || a.scheduleId - b.scheduleId);
}

export interface PushWorkoutsInput {
  userId: string;
  /** The window starts on the runner's local date at this instant; the time it takes the lock when omitted. */
  now?: Date;
}

export interface PushWorkoutsResult {
  window: PushWindow;
  /** POST /workouts/sync calls made. */
  batches: number;
  /** Actions sent, every batch together. */
  actions: number;
  /** Third-party workouts in the window. */
  others: number;
}

/**
 * Makes Garmin hold the runner's sessions of today and the next six days, under the user lock. In rounds:
 * plan the actions from the rows, send up to GARMIN_WORKOUT_BATCH_MAX, store every result. A round that
 * finds nothing left to send after a calendar read stores the third-party workouts in the window and marks
 * the push finished; with nothing to send at the start, one call still reads the calendar. A stopped batch
 * (an outage, a 429, an expired login) keeps what it finished, stores its code on the connection as the
 * push error and throws the error it stands for, so the job retries or defers. A calendar read that
 * fails with nothing left to send still finishes the push, keeping the last list of third-party workouts.
 */
export async function pushWorkouts({
  userId,
  now,
}: PushWorkoutsInput): Promise<PushWorkoutsResult> {
  return withUserLock(userId, async () => {
    try {
      const account = await openGarminAccount(userId);
      const window = pushWindow(localDateOf(now ?? new Date(), account.connection.timezone));
      let calendar: GarminCalendarEntry[] | null = null;
      let batches = 0;
      let sent = 0;
      for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
        const actions = planWorkoutPush({ window, ...(await readPushState(userId, window)) });
        if (actions.length === 0 && calendar !== null) {
          return await finish(userId, window, calendar, { batches, actions: sent });
        }
        const batch = actions.slice(0, GARMIN_WORKOUT_BATCH_MAX);
        const response = await sendBatch(
          account,
          userId,
          { window, readCalendar: true },
          batch.map((planned) => planned.action),
          (answer) => recordResults(userId, batch, answer),
        );
        batches += 1;
        sent += batch.length;
        calendar = response.calendar;
        if (batch.length === 0 && calendar === null) {
          return await finish(userId, window, null, { batches, actions: sent });
        }
      }
      throw new Error(`The workout push did not settle in ${MAX_PUSH_ROUNDS} rounds`);
    } catch (error) {
      await recordPushError(userId, error);
      throw error;
    }
  });
}

async function finish(
  userId: string,
  window: PushWindow,
  calendar: readonly GarminCalendarEntry[] | null,
  counts: { batches: number; actions: number },
): Promise<PushWorkoutsResult> {
  const others = calendar === null ? null : othersIn(calendar, window, await ownWorkoutIds(userId));
  await db
    .update(garminConnection)
    .set({
      workoutsPushedAt: sql`now()`,
      workoutsPushError: null,
      ...(others === null ? {} : { garminCalendar: others }),
      ...keepUpdatedAt,
    })
    .where(eq(garminConnection.userId, userId));
  const result = { window, ...counts, others: others?.length ?? 0 };
  log.info({ userId, ...result, calendarRead: calendar !== null }, "workouts pushed");
  return result;
}

/**
 * Queues a push of the user's calendar after a change to it (a session edit, a goal save, a reconnect),
 * only while the Garmin login works: a missing or expired one would only fail, and a reconnect queues
 * one. A push waiting already covers the change.
 */
export async function queueWorkoutPush(userId: string): Promise<void> {
  const [row] = await db
    .select({ status: garminConnection.status })
    .from(garminConnection)
    .where(eq(garminConnection.userId, userId));
  if (row?.status !== "ok") return;
  await enqueuePushWorkouts({ userId });
}

/** Where sending workouts stands for the user; third-party workouts only from today on, in the window. */
export async function readPushStatus(userId: string, now = new Date()): Promise<GarminPushStatus> {
  const [row] = await db
    .select({
      timezone: userSettings.timezone,
      status: garminConnection.status,
      pushedAt: garminConnection.workoutsPushedAt,
      error: garminConnection.workoutsPushError,
      calendar: garminConnection.garminCalendar,
    })
    .from(userSettings)
    .leftJoin(garminConnection, eq(garminConnection.userId, userSettings.userId))
    .where(eq(userSettings.userId, userId));
  if (!row) throw new Error("The user has no settings row");
  const window = pushWindow(localDateOf(now, row.timezone));
  return {
    connection: row.status ?? "not_connected",
    pushing: await isPushing(userId),
    pushedAt: row.pushedAt?.toISOString() ?? null,
    error: row.error,
    others: (row.calendar ?? []).filter((entry) => inWindow(entry.date, window)),
  };
}

/** POST /api/calendar/push: queues a push now; 409 without a working Garmin login. */
export async function requestWorkoutPush(userId: string): Promise<GarminPushResponse> {
  await requireGarminConnection(userId);
  await enqueuePushWorkouts({ userId });
  return { garmin: await readPushStatus(userId) };
}

/**
 * POST /api/calendar/unschedule: takes third-party workouts off the runner's Garmin calendar, in the
 * request under the user lock, so the runner sees the outcome. Only workouts listed as others in the
 * window qualify (404 otherwise): the app never touches a workout it does not show. The workouts stay in
 * the runner's Garmin library. Each one unscheduled, or already gone, leaves the stored list at once; the
 * next push's calendar read refreshes the rest. A stop is recorded and thrown like the push's.
 */
export async function unscheduleOthers(
  userId: string,
  scheduleIds: readonly number[],
  now = new Date(),
): Promise<GarminPushResponse> {
  const wanted = [...new Set(scheduleIds)];
  const listed = new Set((await readPushStatus(userId, now)).others.map((o) => o.scheduleId));
  if (wanted.some((id) => !listed.has(id))) {
    throw new DomainError(
      ErrorCode.notFound,
      404,
      "That workout is not on the Garmin calendar this week. Refresh and try again.",
    );
  }

  await withUserLock(userId, async () => {
    try {
      const account = await openGarminAccount(userId);
      const window = pushWindow(localDateOf(now, account.connection.timezone));
      const done = new Set<number>();
      const record = async (answer: GarminWorkoutSyncResponse) => {
        for (const result of answer.results) {
          if (result.outcome === "done") done.add(Number(result.ref));
        }
        await storeOthers(userId, (others) => others.filter((o) => !done.has(o.scheduleId)));
      };
      for (let start = 0; start < wanted.length; start += GARMIN_WORKOUT_BATCH_MAX) {
        const actions = wanted.slice(start, start + GARMIN_WORKOUT_BATCH_MAX).map((scheduleId) => ({
          action: "unschedule" as const,
          ref: String(scheduleId),
          scheduleId,
        }));
        // No calendar read: the stored list loses what was unscheduled, and the next push reads the rest.
        await sendBatch(account, userId, { window, readCalendar: false }, actions, record);
      }
      log.info({ userId, unscheduled: done.size }, "garmin workouts unscheduled");
    } catch (error) {
      await recordPushError(userId, error);
      throw error;
    }
  });
  return { garmin: await readPushStatus(userId, now) };
}

async function storeOthers(
  userId: string,
  change: (others: OtherGarminWorkout[]) => OtherGarminWorkout[],
): Promise<void> {
  const [row] = await db
    .select({ calendar: garminConnection.garminCalendar })
    .from(garminConnection)
    .where(eq(garminConnection.userId, userId));
  if (!row) return;
  await db
    .update(garminConnection)
    .set({ garminCalendar: change(row.calendar), ...keepUpdatedAt })
    .where(eq(garminConnection.userId, userId));
}
