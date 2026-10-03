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

/** Whether the runner can still change a session: dated today or later, and neither run nor dropped. */
export function canChange(session: Pick<PlanSession, "date" | "status">, today: string): boolean {
  return session.date >= today && (session.status === "planned" || session.status === "moved");
}
