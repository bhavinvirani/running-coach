import {
  type CoachDetail,
  type DeltaRejection,
  isGpsGlitch,
  type PauseReason,
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

// The user message for run-insight: the run's numbers in the user's units, the detail level, the
// sessions planned that day and next, so "what to do next" can name the session, and since v2 the days
// since the previous run, an open training pause and whether the coach may change the next session.
// Built only from the activity row, two settings, the user's own sessions and pause, and the change
// check, so it cannot carry the API key, Garmin tokens, the email or another user's data.

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

/** What the coach knows beyond the run and the plan (run-insight v2). */
export interface InsightContext {
  /** Local days from the runner's previous run to this one (0: the same day); null with none on record. */
  previousRunDays: number | null;
  /** The runner's open training pause; null while training runs. */
  pause: { reason: PauseReason; startDate: string } | null;
  /** Whether the coach may change the next session, from coachChangeTarget; reason null when allowed. */
  planChange: { allowed: boolean; reason: DeltaRejection | null };
}

const NOT_RECORDED = "not recorded";

const PAUSE_WORDS: Record<PauseReason, string> = {
  sick: "sick",
  injured: "pain or injury",
  break: "a break",
};

// Why the coach may not change the next session, in the prompt's words.
const REFUSAL_WORDS: Record<DeltaRejection, string> = {
  race: "the next session is a race",
  custom: "the next session is the runner's own workout",
  locked: "the next session is done, missed or past",
  adjusted: "the coach already changed the next session",
  paused: "training is paused",
  stale_run: "only the newest run of the last 7 days can change the plan",
  no_session: "nothing is planned after this run",
  no_change: "the next session cannot change",
  invalid: "the next session cannot change",
};

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

function previousRunLine(days: number | null): string {
  if (days === null) return "Previous run: none on record";
  if (days === 0) return "Previous run: the same day";
  return `Previous run: ${days} ${days === 1 ? "day" : "days"} before`;
}

function contextLines(context: InsightContext): { before: string[]; after: string[] } {
  const before = [previousRunLine(context.previousRunDays)];
  if (context.pause) {
    const { reason, startDate } = context.pause;
    before.push(`Training pause: ${PAUSE_WORDS[reason]} since ${formatLocalDate(startDate)}`);
  }
  const { allowed, reason } = context.planChange;
  const change = allowed ? "allowed" : `not allowed (${REFUSAL_WORDS[reason ?? "no_change"]})`;
  return { before, after: [`Plan change for the next session: ${change}`] };
}

export function buildRunInsightInput(
  activity: InsightActivity,
  settings: InsightSettings,
  plan: InsightPlan | null,
  context: InsightContext,
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
  const { before, after } = contextLines(context);
  lines.push(...before, ...planLines(plan, units), ...after);
  return lines.join("\n");
}
