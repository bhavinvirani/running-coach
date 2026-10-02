// Calendar dates as "YYYY-MM-DD" strings in the user's own time zone. Garmin ranges, job keys and plans
// work in local dates; arithmetic runs on UTC midnights so DST never shifts a day.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcMidnight(date: string): number {
  if (!ISO_DATE.test(date)) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) throw new RangeError(`Not a calendar date: ${date}`);
  return time;
}

export function addDays(date: string, days: number): string {
  return new Date(toUtcMidnight(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b; negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMidnight(b) - toUtcMidnight(a)) / DAY_MS);
}

/** The calendar date an instant falls on in an IANA time zone. */
export function localDateOf(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export interface DateRange {
  start: string;
  end: string;
}

/** Splits [start, end] (inclusive) into consecutive ranges of at most `size` days, oldest first. */
export function dateChunks(start: string, end: string, size: number): DateRange[] {
  if (size < 1) throw new RangeError("size must be at least 1");
  const chunks: DateRange[] = [];
  for (let from = start; daysBetween(from, end) >= 0; from = addDays(from, size)) {
    const to = addDays(from, size - 1);
    chunks.push({ start: from, end: daysBetween(to, end) < 0 ? end : to });
  }
  return chunks;
}

/** Noon UTC on a date: an instant whose local date is that date or the next in every time zone. */
export function noonUtc(date: string): Date {
  return new Date(toUtcMidnight(date) + DAY_MS / 2);
}
