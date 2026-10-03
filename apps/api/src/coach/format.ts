import {
  distanceInUnits,
  elevationInUnits,
  paceSecondsPerUnit,
  type Units,
} from "@running-coach/shared";

// Numbers as the coach reads and writes them, already in the user's units. They follow the web app's
// rules (apps/web/src/lib/format.ts: pace m:ss, duration h:mm:ss or mm:ss, one decimal distance), so a
// coach card reads the same numbers as the run screen beside it.

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 1:42:00 or 05:30 */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

export function unitLabel(units: Units): string {
  return units === "km" ? "km" : "mi";
}

/** 18.0 km */
export function formatDistance(distanceM: number, units: Units): string {
  return `${distanceInUnits(distanceM, units).toFixed(1)} ${unitLabel(units)}`;
}

/** 5:40 /km, or null without a distance. Seconds are rounded first so 299.6 reads 5:00, never 4:60. */
export function formatPace(distanceM: number, durationS: number, units: Units): string | null {
  const pace = paceSecondsPerUnit(distanceM, durationS, units);
  if (pace === null) return null;
  const total = Math.round(pace);
  return `${Math.floor(total / 60)}:${pad(total % 60)} /${unitLabel(units)}`;
}

/** 142 m, or 466 ft in miles */
export function formatElevation(meters: number, units: Units): string {
  return `${Math.round(elevationInUnits(meters, units))} ${units === "km" ? "m" : "ft"}`;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** "Thursday 8 October 2026" from a local date "2026-10-08" (no zone math), or the input unchanged. */
export function formatLocalDate(localDate: string): string {
  const match = LOCAL_DATE.exec(localDate);
  if (!match) return localDate;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const monthName = date.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${weekday} ${day} ${monthName} ${year}`;
}

/** "Sunday 27 September 2026, 08:00" from Garmin's wall-clock "2026-09-27 08:00:00" (no zone math). */
export function formatLocalStart(startLocal: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(startLocal);
  if (!match) return startLocal;
  const [, localDate = "", hour = "", minute = ""] = match;
  return `${formatLocalDate(localDate)}, ${hour}:${minute}`;
}
