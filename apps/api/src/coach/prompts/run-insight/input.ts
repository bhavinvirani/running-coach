import { type CoachDetail, isGpsGlitch, type Units } from "@running-coach/shared";
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatLocalStart,
  formatPace,
} from "../../format";

// The user message for run-insight: the run's numbers in the user's units and the detail level. Built
// only from the activity row and two settings, so it cannot carry the API key, Garmin tokens, the email
// or another user's data.

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

export function buildRunInsightInput(activity: InsightActivity, settings: InsightSettings): string {
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
  return lines.join("\n");
}
