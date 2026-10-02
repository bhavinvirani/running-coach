import type { Units } from "@running-coach/shared";

/** Shown wherever a value is missing (indoor run without distance, no HR, never synced). */
export const MISSING = "–";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** "/km" or "/mi". */
export function paceUnitLabel(unit: Units): string {
  return unit === "km" ? "/km" : "/mi";
}

/** 305 → "5:05". Seconds are rounded first so 299.6 reads 5:00, never 4:60. */
export function formatPaceValue(secondsPerUnit: number | null | undefined): string {
  if (!isFiniteNumber(secondsPerUnit) || secondsPerUnit <= 0) return MISSING;
  const total = Math.round(secondsPerUnit);
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

/** 305, "km" → "5:05 /km". */
export function formatPace(secondsPerUnit: number | null | undefined, unit: Units): string {
  const value = formatPaceValue(secondsPerUnit);
  return value === MISSING ? MISSING : `${value} ${paceUnitLabel(unit)}`;
}

/** 330 → "05:30"; 4325 → "1:12:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isFiniteNumber(seconds) || seconds < 0) return MISSING;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(rest)}` : `${pad2(minutes)}:${pad2(rest)}`;
}

/** Distance already converted to the user's unit: 10.04, "km" → "10.0 km". */
export function formatDistance(distanceInUnit: number | null | undefined, unit: Units): string {
  if (!isFiniteNumber(distanceInUnit) || distanceInUnit < 0) return MISSING;
  return `${distanceInUnit.toFixed(1)} ${unit}`;
}

/**
 * A UTC instant shown in the user's time zone: "Sun 27 Sep 2026, 11:42".
 * Built from parts so the output is the same in every browser (ICU spells September "Sept" in en-GB).
 */
export function formatDateTime(isoUtc: string | null | undefined, timeZone: string): string {
  if (!isoUtc) return MISSING;
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return MISSING;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const month = MONTHS[Number(part("month")) - 1] ?? "";
  return `${part("weekday")} ${part("day")} ${month} ${part("year")}, ${part("hour")}:${part("minute")}`;
}
