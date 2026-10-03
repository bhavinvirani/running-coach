/**
 * Calendar dates as the plan writes them, "2026-10-05", with no time and no zone. Arithmetic runs in UTC,
 * which has no DST, so adding a day never lands on the same or the day after next.
 */

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * Today's date in the runner's time zone, from the browser clock: the plan's days are the runner's days,
 * so a phone still on another zone after a flight marks the same week as at home. Tests pin the clock
 * with vi.setSystemTime.
 */
export function today(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  return `${part("year")}-${pad2(part("month"))}-${pad2(part("day"))}`;
}

/** "2026-10-05" plus 6 days → "2026-10-11"; across months, years and DST changes alike. */
export function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return isoDate(day);
}

/** Whole days from one date to another: "2026-10-05" to "2026-10-08" → 3; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The Monday of the Monday-to-Sunday week that holds the date: "2026-10-08" (a Thursday) → "2026-10-05". */
export function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}
