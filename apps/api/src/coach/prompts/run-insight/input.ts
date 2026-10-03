import {
  type CoachDetail,
  isGpsGlitch,
  SESSION_TYPE_NAMES,
  type SessionType,
  type Units,
} from "@running-coach/shared";
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatLocalDate,
  formatLocalStart,
  formatPace,
} from "../../format";

// The user message for run-insight: the run's numbers in the user's units, the detail level, and the
// sessions planned that day and next, so "what to do next" can name the session. Built only from the
// activity row, two settings and the user's own sessions, so it cannot carry the API key, Garmin
// tokens, the email or another user's data.

/** The run as the coach sees it, SI units; an `activity` row satisfies it. */
export interface InsightActivity {
  type: string;
  /** Wall-clock start, "2026-09-27 08:00:00". */
  startLocal: string;
  distanceM: number;
  durationS: number;
  avgHr: number | null;
  maxHr: number | null;
  cadence: number | null;
  calories: number | null;
  elevationGainM: number | null;
  isIndoor: boolean;
  isManual: boolean;
}

export interface InsightSettings {
  units: Units;
  coachDetail: CoachDetail;
}

export interface InsightSession {
  /** Local date, "2026-10-08". */
  date: string;
  type: SessionType;
  /** Null for a custom workout saved without a title. */
  title: string | null;
  distanceM: number;
  durationS: number;
}

export interface InsightPlan {
  /** Sessions on the run's local date (active plan or custom, not skipped), at most 3. */
  planned: InsightSession[];
  /** The first session after the run's local date that is planned or moved, or null. */
  next: InsightSession | null;
}

const NOT_RECORDED = "not recorded";

function kindOf(activity: InsightActivity): string {
  if (activity.isManual) return "entered by hand";
  if (activity.isIndoor) return "indoor run (treadmill)";
  return activity.type === "trail_running" ? "trail run" : "outdoor run";
}

function dataNotes(activity: InsightActivity): string[] {
  const notes: string[] = [];
  if (activity.isManual) notes.push("Entered by hand, so there is no sensor data.");
  if (activity.isIndoor) notes.push("Indoor run: distance and pace are the watch's estimate.");
  if (isGpsGlitch(activity.distanceM, activity.durationS)) {
    notes.push("The pace is faster than any human run, so the GPS distance is wrong. Ignore pace.");
  }
  if (activity.avgHr === null) notes.push("No heart rate was recorded.");
  return notes;
}

/** "Intervals (intervals), 9.0 km, 50:00": its name, its type, and the numbers it has. */
export function describeSession(session: InsightSession, units: Units): string {
  // One line per value in the message, so a title cannot add lines of its own.
  const title = session.title?.replace(/\s+/g, " ").trim();
  const parts = [`${title || SESSION_TYPE_NAMES[session.type]} (${session.type})`];
  if (session.distanceM > 0) parts.push(formatDistance(session.distanceM, units));
  if (session.durationS > 0) parts.push(formatDuration(session.durationS));
  return parts.join(", ");
}

function planLines(plan: InsightPlan | null, units: Units): string[] {
  if (plan === null) return ["Plan: none"];
  const planned = plan.planned.map((session) => describeSession(session, units));
  const next = plan.next
    ? `${formatLocalDate(plan.next.date)}, ${describeSession(plan.next, units)}`
    : "none";
  return [
    `Planned that day: ${planned.length > 0 ? planned.join("; ") : "nothing"}`,
    `Next planned session: ${next}`,
  ];
}

export function buildRunInsightInput(
  activity: InsightActivity,
  settings: InsightSettings,
  plan: InsightPlan | null,
): string {
  const { units } = settings;
  const glitch = isGpsGlitch(activity.distanceM, activity.durationS);
  const pace = glitch ? null : formatPace(activity.distanceM, activity.durationS, units);
  const bpm = (value: number | null) =>
    value === null ? NOT_RECORDED : `${Math.round(value)} bpm`;
  const lines = [
    `Detail level: ${settings.coachDetail}`,
    `Units: ${units === "km" ? "kilometers" : "miles"}`,
    `Start: ${formatLocalStart(activity.startLocal)}`,
    `Kind: ${kindOf(activity)}`,
    `Distance: ${formatDistance(activity.distanceM, units)}`,
    `Duration: ${formatDuration(activity.durationS)}`,
    `Average pace: ${pace ?? "not available"}`,
    `Average heart rate: ${bpm(activity.avgHr)}`,
    `Max heart rate: ${bpm(activity.maxHr)}`,
    `Cadence: ${activity.cadence === null ? NOT_RECORDED : `${Math.round(activity.cadence)} steps per minute`}`,
    `Elevation gain: ${activity.elevationGainM === null ? NOT_RECORDED : formatElevation(activity.elevationGainM, units)}`,
    `Calories: ${activity.calories === null ? NOT_RECORDED : String(Math.round(activity.calories))}`,
  ];
  const notes = dataNotes(activity);
  if (notes.length > 0) lines.push(`Data notes: ${notes.join(" ")}`);
  lines.push(...planLines(plan, units));
  return lines.join("\n");
}
