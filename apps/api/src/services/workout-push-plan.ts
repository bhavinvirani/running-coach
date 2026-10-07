import { createHash } from "node:crypto";
import { garminWorkout } from "@running-coach/engine";
import {
  type GarminWorkout,
  garminWorkoutName,
  type GarminWorkoutAction,
  type GarminWorkoutResult,
  type PlanPaces,
  PUSH_WINDOW_DAYS,
  type SessionStatus,
  type SessionSteps,
  type SessionTarget,
  type SessionType,
  type Units,
} from "@running-coach/shared";
import { addDays } from "../lib/local-date";

// What the workout push (workout-push.ts) sends to Garmin, as pure functions of the sessions it reads, so
// every rule is unit-tested without Garmin or a database (SPEC: Garmin calendar). The push keeps today and
// the next six days of the runner's local calendar on Garmin: each session there is compared with the ids,
// scheduled date and content hash stored on its row, and only a difference becomes an action.

/** A session's columns the push reads and writes. */
export interface PushSession {
  id: string;
  /** Null for a custom workout. */
  planId: string | null;
  date: string;
  type: SessionType;
  title: string | null;
  target: SessionTarget;
  steps: SessionSteps;
  status: SessionStatus;
  garminWorkoutId: string | null;
  garminScheduleId: string | null;
  garminDate: string | null;
  garminHash: string | null;
}

/** Local dates, both included. */
export interface PushWindow {
  start: string;
  end: string;
}

/** Today and the next PUSH_WINDOW_DAYS - 1 days. */
export function pushWindow(today: string): PushWindow {
  return { start: today, end: addDays(today, PUSH_WINDOW_DAYS - 1) };
}

export function inWindow(date: string, window: PushWindow): boolean {
  return date >= window.start && date <= window.end;
}

// Strength comes in slice 11 as sets, not a running workout; a rest day has no row.
const NOT_ON_THE_WATCH: ReadonlySet<SessionType> = new Set(["rest", "strength"]);
const WANTED_STATUSES: ReadonlySet<SessionStatus> = new Set(["planned", "moved"]);
// Done and missed sessions are history: what Garmin holds for them stays.
const REMOVABLE_STATUSES: ReadonlySet<SessionStatus> = new Set(["planned", "moved", "skipped"]);

export interface DesiredWorkout {
  workout: GarminWorkout;
  /** sha256 hex of the workout's JSON: another name, step or pace band is another hash. */
  hash: string;
}

/** The workout a session goes to the watch as, or null for a type the watch does not run or no steps. */
export function desiredWorkout(
  session: Pick<PushSession, "title" | "type" | "target" | "steps">,
  paces: PlanPaces,
  units: Units,
): DesiredWorkout | null {
  if (NOT_ON_THE_WATCH.has(session.type) || session.steps.length === 0) return null;
  const workout = garminWorkout({
    name: garminWorkoutName(session, units),
    steps: session.steps,
    paces,
  });
  return { workout, hash: createHash("sha256").update(JSON.stringify(workout)).digest("hex") };
}

/**
 * True when Garmin holds the session as it is now: uploaded with its current content, scheduled on its
 * date. `paces` are the ones its zones read (its plan's, or the active plan's for a custom workout).
 */
export function isOnGarmin(session: PushSession, paces: PlanPaces | null, units: Units): boolean {
  if (
    paces === null ||
    session.garminWorkoutId === null ||
    session.garminScheduleId === null ||
    session.garminDate !== session.date
  ) {
    return false;
  }
  return desiredWorkout(session, paces, units)?.hash === session.garminHash;
}

/** One action of the push with the session it is for, as the session stood when it was planned. */
export interface PlannedAction {
  action: Exclude<GarminWorkoutAction, { action: "unschedule" }>;
  session: PushSession;
  /** The hash of the workout a create uploads; null for the other actions. */
  hash: string | null;
}

export interface PushPlanInput {
  window: PushWindow;
  /** The runner's sessions in the window and every one holding a Garmin workout; others are ignored. */
  sessions: readonly PushSession[];
  /** The active plan; without one nothing is wanted on Garmin, since custom workouts read its paces. */
  activePlan: { id: string; paces: PlanPaces } | null;
  /** The open pause's start: sessions from it on leave the watch until it ends. Null while training runs. */
  pausedFrom: string | null;
  units: Units;
}

function garminId(id: string): number {
  return Number(id);
}

/**
 * The session is wanted on Garmin: in the window, of the active plan or custom, planned or moved, and
 * before the open pause's start.
 */
function isWanted(
  session: PushSession,
  window: PushWindow,
  { activePlan, pausedFrom }: Pick<PushPlanInput, "activePlan" | "pausedFrom">,
): boolean {
  return (
    activePlan !== null &&
    inWindow(session.date, window) &&
    (session.planId === null || session.planId === activePlan.id) &&
    WANTED_STATUSES.has(session.status) &&
    (pausedFrom === null || session.date < pausedFrom)
  );
}

const byDate = (a: PlannedAction, b: PlannedAction, date: (p: PlannedAction) => string) =>
  date(a).localeCompare(date(b)) || a.session.id.localeCompare(b.session.id);

/**
 * The actions that make Garmin match the sessions, removes first, then moves, then creates, each in date
 * order; ref is the session id. Wanted without a workout: create. Wanted with a workout of other content:
 * remove it and create again (garminconnect's update_workout is unverified), or only create when the old
 * one sits on a past day, which is never touched. Same content, not scheduled on its date: move (the old
 * scheduled instance is unscheduled unless it is in the past). Not wanted but holding a workout, planned,
 * moved or skipped, scheduled today or later: remove (a superseded plan's session, a skipped one, one moved
 * out of the window, one the open pause holds). Done and missed sessions and anything before today are
 * never touched.
 */
export function planWorkoutPush({
  window,
  sessions,
  activePlan,
  pausedFrom,
  units,
}: PushPlanInput): PlannedAction[] {
  const removes: PlannedAction[] = [];
  const moves: PlannedAction[] = [];
  const creates: PlannedAction[] = [];
  const remove = (session: PushSession) =>
    removes.push({
      action: {
        action: "remove",
        ref: session.id,
        workoutId: garminId(session.garminWorkoutId!),
        scheduleId: session.garminScheduleId === null ? null : garminId(session.garminScheduleId),
      },
      session,
      hash: null,
    });

  for (const session of sessions) {
    const held = session.garminWorkoutId !== null;
    // The day Garmin shows the workout on, or would: a past one stays as it is.
    const heldFromToday = (session.garminDate ?? session.date) >= window.start;
    const desired =
      activePlan !== null && isWanted(session, window, { activePlan, pausedFrom })
        ? desiredWorkout(session, activePlan.paces, units)
        : null;

    if (desired === null) {
      if (held && REMOVABLE_STATUSES.has(session.status) && heldFromToday) remove(session);
      continue;
    }
    if (!held || desired.hash !== session.garminHash) {
      if (held && heldFromToday) remove(session);
      creates.push({
        action: { action: "create", ref: session.id, date: session.date, workout: desired.workout },
        session,
        hash: desired.hash,
      });
      continue;
    }
    if (session.garminScheduleId === null || session.garminDate !== session.date) {
      moves.push({
        action: {
          action: "move",
          ref: session.id,
          workoutId: garminId(session.garminWorkoutId!),
          scheduleId:
            session.garminScheduleId !== null && heldFromToday
              ? garminId(session.garminScheduleId)
              : null,
          date: session.date,
        },
        session,
        hash: null,
      });
    }
  }

  return [
    ...removes.toSorted((a, b) => byDate(a, b, (p) => p.session.garminDate ?? p.session.date)),
    ...moves.toSorted((a, b) => byDate(a, b, (p) => p.session.date)),
    ...creates.toSorted((a, b) => byDate(a, b, (p) => p.session.date)),
  ];
}

/** The garmin_* columns of a session row. */
export interface GarminColumns {
  garminWorkoutId: string | null;
  garminScheduleId: string | null;
  garminDate: string | null;
  garminHash: string | null;
}

const FORGOTTEN: GarminColumns = {
  garminWorkoutId: null,
  garminScheduleId: null,
  garminDate: null,
  garminHash: null,
};

/**
 * What to store on the session after one result: the ids Garmin now holds, whatever the outcome (a create
 * that uploaded but failed to schedule keeps its workout, so the retry only schedules it); the date only
 * while scheduled; the hash while a workout is held, the uploaded one's after a create. gone forgets
 * everything, so the next round creates it again; skipped changes nothing (null).
 */
export function garminColumnsAfter(
  { action, session, hash }: PlannedAction,
  result: GarminWorkoutResult,
): GarminColumns | null {
  if (result.outcome === "skipped") return null;
  if (result.outcome === "gone") return FORGOTTEN;
  const workoutId = result.workoutId === null ? null : String(result.workoutId);
  const scheduleId = result.scheduleId === null ? null : String(result.scheduleId);
  const kept = scheduleId !== null && scheduleId === session.garminScheduleId;
  let garminDate: string | null;
  if (scheduleId === null) garminDate = null;
  else if (action.action === "remove" || (action.action === "move" && kept)) {
    // The old scheduled instance is still there: an unschedule failed.
    garminDate = session.garminDate;
  } else garminDate = action.date;
  return {
    garminWorkoutId: workoutId,
    garminScheduleId: scheduleId,
    garminDate,
    garminHash: workoutId === null ? null : action.action === "create" ? hash : session.garminHash,
  };
}
