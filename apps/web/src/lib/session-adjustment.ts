import {
  distanceInUnits,
  type PlanChange,
  type PlanSession,
  type SessionSnapshot,
  type Units,
} from "@running-coach/shared";
import { formatDistance, formatDuration, formatShortDay } from "./format";
import { sessionTypeName } from "./session-type";

/** The words for a changed session, on Today, the plan week and the session screen alike. */
export const adjustmentCopy = {
  /** A re-entry after a pause or a gap of 7 or more days without a run. */
  eased: "Eased for your return",
  changed: "Changed by the coach",
  rested: "Skipped by the coach",
} as const;

/** How much a session asks: its distance in the runner's unit, else its time (strength); null with neither. */
export function snapshotAmount(target: SessionSnapshot["target"], units: Units): string | null {
  if (target.distanceM > 0) return formatDistance(distanceInUnits(target.distanceM, units), units);
  return target.durationS > 0 ? formatDuration(target.durationS) : null;
}

/**
 * A session the coach turned into a rest. Its line already says "Skipped by the coach", so the lists and the
 * session screen leave out the plain Skipped beside it.
 */
export function isCoachRest(session: Pick<PlanSession, "adjustment">): boolean {
  return session.adjustment?.source === "coach" && session.adjustment.kind === "rest";
}

/**
 * The one line under a changed session that says what it was, since the session shows what it is now:
 * "Eased for your return, was 14.0 km", "Changed by the coach, was Intervals 11.6 km" (the original type
 * named only when the change replaced it), "Skipped by the coach" for a coach rest. Null while the session
 * is as planned.
 */
export function adjustmentLine(
  session: Pick<PlanSession, "adjustment" | "type">,
  units: Units,
): string | null {
  const { adjustment } = session;
  if (adjustment === null) return null;
  if (isCoachRest(session)) return adjustmentCopy.rested;
  const prefix = adjustment.source === "coach" ? adjustmentCopy.changed : adjustmentCopy.eased;
  const { original } = adjustment;
  const was = [
    original.type === session.type ? null : sessionTypeName(original.type),
    snapshotAmount(original.target, units),
  ].filter((part) => part !== null);
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
