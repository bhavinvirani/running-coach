import { distanceInUnits, paceSecondsPerUnit, type Units } from "@running-coach/shared";

// Numbers as the coach reads and writes them, already in the user's units. The web app formats for
// screens on its own; these only build prompt input and fallback cards.

const FEET_PER_METER = 3.280_84;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 1:42:00 or 31:05 */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export function unitLabel(units: Units): string {
  return units === "km" ? "km" : "mi";
}

/** 18.00 km */
export function formatDistance(distanceM: number, units: Units): string {
  return `${distanceInUnits(distanceM, units).toFixed(2)} ${unitLabel(units)}`;
}

/** 5:40 /km, or null without a distance */
export function formatPace(distanceM: number, durationS: number, units: Units): string | null {
  const pace = paceSecondsPerUnit(distanceM, durationS, units);
  return pace === null ? null : `${formatDuration(pace)} /${unitLabel(units)}`;
}

/** 142 m, or 466 ft in miles */
export function formatElevation(meters: number, units: Units): string {
  return units === "km" ? `${Math.round(meters)} m` : `${Math.round(meters * FEET_PER_METER)} ft`;
}

/** "Sunday 27 September 2026, 08:00" from Garmin's wall-clock "2026-09-27 08:00:00" (no zone math). */
export function formatLocalStart(startLocal: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(startLocal);
  if (!match) return startLocal;
  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const monthName = date.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${weekday} ${day} ${monthName} ${year}, ${pad(hour)}:${pad(minute)}`;
}
