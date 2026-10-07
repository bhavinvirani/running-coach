import type { PlanSession } from "@running-coach/shared";
import { isCoachRest } from "@/lib/session-adjustment";

/** Every sentence and label on a plan week, so the wording is read and changed in one place. */
export const planWeekCopy = {
  /** The title while the plan loads or when there is no such week. */
  title: "Week",
  loading: "Loading the week",
  days: "Days",
  /** The address names a week the plan does not have: an old link, or a plan made again shorter. */
  noSuchWeek: (number: string) => `Your plan has no week ${number}.`,
  noPlan: "You have no plan yet.",
  openPlan: "Open plan",
  add: "Add",
  /** Add's name for a screen reader, which hears seven of them: "Add a workout on Thu 8 Oct". */
  addOn: (day: string) => `Add a workout on ${day}`,
  skipped: "Skipped",
  done: "Done",
  missed: "Missed",
  paused: "Paused",
} as const;

/**
 * What happened to a session, for its row: Skipped, Done, Missed or Paused (in an open pause); null while
 * it is to come, moved or not. A coach rest is left to its adjustment line, which says it was skipped.
 */
export function sessionStateWord(
  session: Pick<PlanSession, "status" | "paused" | "adjustment">,
): string | null {
  if (session.status === "skipped") return isCoachRest(session) ? null : planWeekCopy.skipped;
  if (session.status === "done") return planWeekCopy.done;
  if (session.status === "missed") return planWeekCopy.missed;
  return session.paused ? planWeekCopy.paused : null;
}
