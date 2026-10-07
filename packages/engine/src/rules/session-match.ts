import type { SessionStatus } from "@running-coach/shared";
import { daysBetween } from "../dates";

export interface MatchSession {
  id: string;
  /** Its local date. */
  date: string;
  status: SessionStatus;
  /** The session's target distance: the longest run of a day goes to its longest session. */
  distanceM: number;
  activityId: string | null;
}

export interface MatchRun {
  id: string;
  /** The run's local date, in the time zone it was run in. */
  date: string;
  distanceM: number;
}

export interface MatchSessionsInput {
  /** The runner's local today. */
  today: string;
  /** The active plan's sessions and the custom workouts, any dates and statuses. */
  sessions: readonly MatchSession[];
  /** Every run on record over those dates, indoor and manual ones included. */
  runs: readonly MatchRun[];
  /** The start of the open pause, null when training runs. */
  pausedFrom: string | null;
}

export interface SessionMatch {
  id: string;
  status: SessionStatus;
  activityId: string | null;
}

interface Sized {
  id: string;
  distanceM: number;
}

/** Longest first, then by id, so the same day pairs the same way every time. */
function longestFirst(a: Sized, b: Sized): number {
  return b.distanceM - a.distanceM || (a.id < b.id ? -1 : 1);
}

function byDate<T extends { date: string }>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) grouped.set(item.date, [...(grouped.get(item.date) ?? []), item]);
  return grouped;
}

/**
 * Which sessions a day's runs completed, recomputed from scratch so a run deleted or moved on Garmin
 * takes its done mark with it. Each day up to today pairs its sessions with its runs, longest with
 * longest, each run once. A session before today with no run is missed and stays on its date: missed
 * runs are dropped, never rescheduled. Today's sessions and those inside the open pause are not missed
 * yet, so they go back to planned when their run is gone. Skipped and future sessions are never
 * touched. Returns only the sessions that change, in input order.
 */
export function matchSessions({
  today,
  sessions,
  runs,
  pausedFrom,
}: MatchSessionsInput): SessionMatch[] {
  const open = sessions.filter(
    (session) => session.status !== "skipped" && daysBetween(session.date, today) >= 0,
  );
  const runsByDate = byDate(runs);
  const runFor = new Map<string, string>();
  for (const [date, daySessions] of byDate(open)) {
    const dayRuns = (runsByDate.get(date) ?? []).sort(longestFirst);
    daySessions.sort(longestFirst).forEach((session, k) => {
      const run = dayRuns[k];
      if (run !== undefined) runFor.set(session.id, run.id);
    });
  }
  return open.flatMap((session) => {
    const next = matched(session, runFor.get(session.id), { today, pausedFrom });
    return next.status === session.status && next.activityId === session.activityId
      ? []
      : [{ id: session.id, ...next }];
  });
}

function matched(
  session: MatchSession,
  runId: string | undefined,
  { today, pausedFrom }: { today: string; pausedFrom: string | null },
): Omit<SessionMatch, "id"> {
  if (runId !== undefined) return { status: "done", activityId: runId };
  const inPause = pausedFrom !== null && daysBetween(pausedFrom, session.date) >= 0;
  if (daysBetween(session.date, today) > 0 && !inPause)
    return { status: "missed", activityId: null };
  return session.status === "done" || session.status === "missed"
    ? { status: "planned", activityId: null }
    : { status: session.status, activityId: session.activityId };
}
