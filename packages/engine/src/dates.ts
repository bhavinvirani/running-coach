import type { Weekday } from "@running-coach/shared";

// Local dates as UTC midnights: no time zone or DST can shift a day, and nothing reads the clock.
const DAY_MS = 86_400_000;
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function utcMs(date: string): number {
  const ms = new Date(`${date}T00:00:00Z`).getTime();
  // The format check plus the round trip rejects 2026-02-30, which Date would roll into March.
  if (
    !ISO_DATE.test(date) ||
    Number.isNaN(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  ) {
    throw new RangeError(`Expected a YYYY-MM-DD date, got ${date}`);
  }
  return ms;
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
