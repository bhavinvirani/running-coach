import { and, gte, lt, sql } from "drizzle-orm";
import { activity } from "../db/schema";
import { addDays } from "../lib/local-date";

// A run's dates as every plan reader takes them: the wall-clock date it was run on (start_local), never its
// UTC date, so a run at 00:40 in Berlin counts for that day wherever the server is.

/** A run's own wall-clock date: the day the runner lived, whatever zone the run was in. */
export const runDate = sql<string>`to_char(${activity.startLocal}, 'YYYY-MM-DD')`;

/** Runs whose local date is in [from, to]. start_local is a timestamp without zone, so no zone math. */
export function runDateWithin(from: string, to: string) {
  return and(
    gte(activity.startLocal, `${from} 00:00:00`),
    lt(activity.startLocal, `${addDays(to, 1)} 00:00:00`),
  );
}

/** Runs whose local date is on or before `date`; one in a zone ahead of the runner's may be after it. */
export function runDateUpTo(date: string) {
  return lt(activity.startLocal, `${addDays(date, 1)} 00:00:00`);
}
