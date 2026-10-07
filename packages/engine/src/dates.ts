import type { Weekday } from "@running-coach/shared";

// Local dates as UTC midnights: no time zone or DST can shift a day, and nothing reads the clock.
const DAY_MS = 86_400_000;
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Parsed by hand: the plan builder reads dates by the hundred thousand, and Date's own parser and a
// toISOString round trip were a third of its time.
function utcMs(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  // The format check plus the month's own length rejects 2026-02-30, which Date would roll into March.
  if (
    !ISO_DATE.test(date) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!)
  ) {
    throw new RangeError(`Expected a YYYY-MM-DD date, got ${date}`);
  }
  // setUTCFullYear, unlike Date.UTC, keeps years under 100 as they are.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  return at.getTime();
}

export function addDays(date: string, days: number): string {
  return new Date(utcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS);
}

/** 0 for Monday to 6 for Sunday. */
export function weekdayIndex(day: Weekday): number {
  return WEEKDAYS.indexOf(day);
}

export function weekdayOf(date: string): Weekday {
  // getUTCDay is 0 for Sunday; shift so Monday is 0.
  return WEEKDAYS[(new Date(utcMs(date)).getUTCDay() + 6) % 7]!;
}

/** The date itself when it is a Monday, else the Monday after it. */
export function nextMonday(date: string): string {
  return addDays(date, (7 - weekdayIndex(weekdayOf(date))) % 7);
}
