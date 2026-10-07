import type { PlanSession } from "@running-coach/shared";
import { addDays, weekStart } from "@/lib/dates";

/**
 * The days a session can move to: the rest of its Monday-to-Sunday week, from today on. A missed day is
 * never caught up, so a move never reaches into the past or another week (the API refuses both).
 */
export function moveDays(session: Pick<PlanSession, "date">, today: string): string[] {
  const monday = weekStart(session.date);
  return Array.from({ length: 7 }, (_, offset) => addDays(monday, offset)).filter(
    (date) => date !== session.date && date >= today,
  );
}

/**
 * Whether the runner can still change a session: dated today or later, neither run nor dropped, and not
 * in an open pause, which skips it when the runner is back (a move would only carry it into the pause).
 */
export function canChange(
  session: Pick<PlanSession, "date" | "status" | "paused">,
  today: string,
): boolean {
  return (
    !session.paused &&
    session.date >= today &&
    (session.status === "planned" || session.status === "moved")
  );
}

/**
 * Whether a day takes Add, a workout of the runner's own: from today on, and before an open pause's start
 * (`pauseStart`, null without a pause), from which the API refuses one (session_locked): the pause would
 * skip it when the runner is back.
 */
export function canAdd(date: string, today: string, pauseStart: string | null): boolean {
  return date >= today && (pauseStart === null || date < pauseStart);
}
