import { PUSH_WINDOW_DAYS, type GarminPushStatus, type PlanSession } from "@running-coach/shared";
import { addDays } from "./dates";

/** What happened to a session, which says more than its Garmin state once it is past or off the watch. */
export type SessionStateCaption = "Skipped" | "Done" | "Missed" | "Paused";

/** Where one session stands with the watch, in a word or two. */
export type GarminCaption =
  | SessionStateCaption
  | "On Garmin"
  | "Sent a week ahead"
  | "Not on Garmin"
  | "Sending"
  | "Not sent"
  | "Waiting to send";

const SESSION_STATE_CAPTIONS: ReadonlySet<GarminCaption> = new Set<SessionStateCaption>([
  "Skipped",
  "Done",
  "Missed",
  "Paused",
]);

/** Whether a caption says what happened to the session rather than where its workout is on Garmin. */
export function isSessionStateCaption(caption: GarminCaption): caption is SessionStateCaption {
  return SESSION_STATE_CAPTIONS.has(caption);
}

/**
 * A session's caption on Today, the plan week and the session screen: what happened to it (skipped, done
 * by a run, missed, or paused, which keeps it off the watch), else where it stands on Garmin. `today` is
 * the runner's local date (src/lib/dates.ts), so the push window is the runner's week, as the API counts
 * it. Null where Garmin has no part: a past session, or one without steps (strength) that no watch
 * workout can hold.
 */
export function garminCaption(
  session: Pick<PlanSession, "status" | "paused" | "onGarmin" | "steps" | "date">,
  garmin: Pick<GarminPushStatus, "connection" | "pushing" | "error">,
  today: string,
): GarminCaption | null {
  if (session.status === "skipped") return "Skipped";
  if (session.status === "done") return "Done";
  if (session.status === "missed") return "Missed";
  if (session.paused) return "Paused";
  if (session.onGarmin) return "On Garmin";
  if (session.steps.length === 0 || session.date < today) return null;
  // The push keeps today and the next six days on the watch; later sessions go as their day comes in.
  if (session.date > addDays(today, PUSH_WINDOW_DAYS - 1)) return "Sent a week ahead";
  if (garmin.connection !== "ok") return "Not on Garmin";
  if (garmin.pushing) return "Sending";
  if (garmin.error !== null) return "Not sent";
  return "Waiting to send";
}
