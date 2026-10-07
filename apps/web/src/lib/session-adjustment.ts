import {
  distanceInUnits,
  type PlanChange,
  type PlanSession,
  type SessionSnapshot,
  type Units,
  WALK_RUN_TITLE,
} from "@running-coach/shared";
import { formatDistance, formatDuration, formatShortDay } from "./format";
import { sessionTypeName } from "./session-type";

/** The words for a changed session, on Today, the plan week and the session screen alike. */
export const adjustmentCopy = {
  /** A re-entry after a pause or a gap of 7 or more days without a run. */
  eased: "Eased for your return",
  /** A re-entry that made the session walk-run, in the first 7 days back after illness or injury. */
  walkRun: "Walk-run for your return",
  changed: "Changed by the coach",
  rested: "Skipped by the coach",
  /** A session left in a pause, which I'm back skips. */
  pauseRested: "Skipped during your pause",
} as const;

/** How much a session asks: its distance in the runner's unit, else its time (strength); null with neither. */
export function snapshotAmount(target: SessionSnapshot["target"], units: Units): string | null {
  if (target.distanceM > 0) return formatDistance(distanceInUnits(target.distanceM, units), units);
  return target.durationS > 0 ? formatDuration(target.durationS) : null;
}

/**
 * A session a change turned into a rest: the coach's after a run, or a pause's for a session left in it
 * when the runner came back. Its line already says it was skipped and by what, so the lists and the
 * session screen leave out the plain Skipped beside it.
 */
export function isRestChange(session: Pick<PlanSession, "adjustment">): boolean {
  return session.adjustment?.kind === "rest";
}

/**
 * The one line under a changed session that says what it was, since the session shows what it is now:
 * "Eased for your return, was 14.0 km", "Changed by the coach, was Intervals 11.6 km" (the original type
 * named only when the change replaced it), and for a walk-run always with its type, "Walk-run for your
 * return, was Easy 5.0 km", since its distance can stay the same. A rest says only who skipped it:
 * "Skipped by the coach", "Skipped during your pause" (only the coach and a pause skip a session). Null
 * while the session is as planned.
 */
export function adjustmentLine(
  session: Pick<PlanSession, "adjustment" | "type" | "title">,
  units: Units,
): string | null {
  const { adjustment } = session;
  if (adjustment === null) return null;
  if (isRestChange(session)) {
    return adjustment.source === "coach" ? adjustmentCopy.rested : adjustmentCopy.pauseRested;
  }
  const { original } = adjustment;
  const amount = snapshotAmount(original.target, units);
  if (adjustment.source !== "coach" && session.title === WALK_RUN_TITLE) {
    return wasLine(adjustmentCopy.walkRun, [sessionTypeName(original.type), amount]);
  }
  const prefix = adjustment.source === "coach" ? adjustmentCopy.changed : adjustmentCopy.eased;
  const type = original.type === session.type ? null : sessionTypeName(original.type);
  return wasLine(prefix, [type, amount]);
}

/** "<prefix>, was <parts>", or the prefix alone when nothing is left to say. */
function wasLine(prefix: string, parts: (string | null)[]): string {
  const was = parts.filter((part) => part !== null);
  return was.length === 0 ? prefix : `${prefix}, was ${was.join(" ")}`;
}

/** A session in a change: its type and how much it asks, "Tempo 8.0 km"; a rest is its type alone. */
function snapshotPhrase(snapshot: SessionSnapshot, units: Units): string {
  const amount = snapshot.type === "rest" ? null : snapshotAmount(snapshot.target, units);
  return [sessionTypeName(snapshot.type), amount].filter((part) => part !== null).join(" ");
}

/**
 * The coach's change after a run, as the run's coach card shows it: "Thu 8 Intervals 11.6 km → Easy
 * 10.6 km", or "Fri 9 Easy 5.0 km skipped" for a rest.
 */
export function planChangeLine(change: PlanChange, units: Units): string {
  const day = formatShortDay(change.date);
  const before = snapshotPhrase(change.before, units);
  if (change.kind === "rest") return `${day} ${before} skipped`;
  return `${day} ${before} → ${snapshotPhrase(change.after, units)}`;
}
