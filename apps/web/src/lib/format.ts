import type { Units } from "@running-coach/shared";

/** Shown wherever a value is missing (indoor run without distance, no HR, never synced). */
export const MISSING = "–";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

/** Distance already converted to the user's unit, for a figure that draws the unit itself: 10.04 → "10.0". */
export function formatDistanceValue(distanceInUnit: number | null | undefined): string {
  if (!isFiniteNumber(distanceInUnit) || distanceInUnit < 0) return MISSING;
  return distanceInUnit.toFixed(1);
}

/** Distance already converted to the user's unit: 10.04, "km" → "10.0 km". */
export function formatDistance(distanceInUnit: number | null | undefined, unit: Units): string {
  const value = formatDistanceValue(distanceInUnit);
  return value === MISSING ? MISSING : `${value} ${unit}`;
}

/** 147.6 → "148". Zero means the watch recorded no HR, not a stopped heart. */
export function formatHeartRate(bpm: number | null | undefined): string {
  if (!isFiniteNumber(bpm) || bpm <= 0) return MISSING;
  return Math.round(bpm).toString();
}

/** The calendar fields of a UTC instant in a time zone, read from parts so every browser agrees. */
function zonedParts(isoUtc: string | null | undefined, timeZone: string) {
  if (!isoUtc) return null;
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return null;
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
  return {
    weekday: part("weekday"),
    day: part("day"),
    month: MONTHS[Number(part("month")) - 1] ?? "",
    year: part("year"),
    time: `${part("hour")}:${part("minute")}`,
  };
}

/**
 * A UTC instant shown in the user's time zone: "Sun 27 Sep 2026, 11:42".
 * Built from parts so the output is the same in every browser (ICU spells September "Sept" in en-GB).
 */
export function formatDateTime(isoUtc: string | null | undefined, timeZone: string): string {
  const zoned = zonedParts(isoUtc, timeZone);
  if (!zoned) return MISSING;
  return `${zoned.weekday} ${zoned.day} ${zoned.month} ${zoned.year}, ${zoned.time}`;
}

/** The date of a UTC instant in the user's time zone: "2 Oct 2026". */
export function formatDate(isoUtc: string | null | undefined, timeZone: string): string {
  const zoned = zonedParts(isoUtc, timeZone);
  return zoned ? `${zoned.day} ${zoned.month} ${zoned.year}` : MISSING;
}

/** The wall-clock time of a UTC instant in the user's time zone: "14:05". */
export function formatTime(isoUtc: string | null | undefined, timeZone: string): string {
  return zonedParts(isoUtc, timeZone)?.time ?? MISSING;
}

type CalendarDay = { year: number; month: number; day: number };

/**
 * "2026-09-27" or "2026-09-27T07:12:00" read from its digits, never through a Date in the device's zone,
 * which would shift or reject an hour that a DST change skips. Null for anything that is not a real day.
 */
function calendarDay(value: string | null | undefined): CalendarDay | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = utcDate({ year, month, day });
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Only for weekday and day arithmetic: UTC has no DST, so the calendar day never moves. */
function utcDate({ year, month, day }: CalendarDay): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(day: CalendarDay, days: number): CalendarDay {
  const date = utcDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayOf(day: CalendarDay): string {
  return WEEKDAYS[utcDate(day).getUTCDay()] ?? "";
}

function monthOf(day: CalendarDay): string {
  return MONTHS[day.month - 1] ?? "";
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/;

/**
 * A run's start as its watch showed it, "2026-09-27T07:12:00" → "Sun 27 Sep, 07:12": the runner remembers
 * the local time where they ran, even when the device is now in another zone.
 */
export function formatLocalDateTime(local: string | null | undefined): string {
  const day = calendarDay(local);
  const time = local ? LOCAL_TIME.exec(local) : null;
  if (!day || !time) return MISSING;
  return `${weekdayOf(day)} ${day.day} ${monthOf(day)}, ${time[1] ?? ""}:${time[2] ?? ""}`;
}

/** The day of a run's local start, "2026-09-27T07:12:00" → "Sun 27 Sep". */
export function formatLocalDay(local: string | null | undefined): string {
  const day = calendarDay(local);
  return day ? `${weekdayOf(day)} ${day.day} ${monthOf(day)}` : MISSING;
}

/** A calendar date as month and year, "2021-03-14" → "Mar 2021". */
export function formatMonthYear(date: string | null | undefined): string {
  const day = calendarDay(date);
  return day ? `${monthOf(day)} ${day.year}` : MISSING;
}

/**
 * A Monday-to-Sunday week from its Monday: "21–27 Sep", "29 Sep – 5 Oct". History reaches back years, so
 * a week outside the year in which `newestWeekStart` ends gets its year: "10–16 Mar 2025",
 * "29 Dec 2025 – 4 Jan 2026". The newest week shown is the reference rather than today, so the label
 * depends on the data alone.
 */
export function formatWeekRange(
  weekStart: string | null | undefined,
  newestWeekStart?: string | null,
): string {
  const start = calendarDay(weekStart);
  if (!start) return MISSING;
  const end = addDays(start, 6);
  const newest = calendarDay(newestWeekStart);
  const referenceYear = newest ? addDays(newest, 6).year : end.year;
  const withYear = start.year !== referenceYear || end.year !== referenceYear;

  if (start.year !== end.year) {
    return `${start.day} ${monthOf(start)} ${start.year} – ${end.day} ${monthOf(end)} ${end.year}`;
  }
  const year = withYear ? ` ${end.year}` : "";
  if (start.month === end.month) return `${start.day}–${end.day} ${monthOf(end)}${year}`;
  return `${start.day} ${monthOf(start)} – ${end.day} ${monthOf(end)}${year}`;
}

const COUNT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/** A count with its noun: 1, "run", "runs" → "1 run"; 1240 → "1,240 runs". */
export function formatCount(count: number, singular: string, plural: string): string {
  if (!isFiniteNumber(count) || count < 0) return MISSING;
  return `${COUNT.format(count)} ${count === 1 ? singular : plural}`;
}
