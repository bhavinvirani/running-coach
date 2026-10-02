import type {
  Activity,
  ActivityWeek,
  ActivityWeeksQuery,
  ActivityWeeksResponse,
  LatestActivityResponse,
} from "@running-coach/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { activity } from "../db/schema";

/** The activity columns the contract's activitySchema carries; read with toActivity. */
export const activityColumns = {
  id: activity.id,
  type: activity.type,
  startUtc: activity.startUtc,
  startLocal: activity.startLocal,
  tz: activity.tz,
  distanceM: activity.distanceM,
  durationS: activity.durationS,
  avgHr: activity.avgHr,
  maxHr: activity.maxHr,
  cadence: activity.cadence,
  calories: activity.calories,
  elevationGainM: activity.elevationGainM,
  isIndoor: activity.isIndoor,
  isManual: activity.isManual,
  eventType: activity.eventType,
};

type ActivityRow = Pick<typeof activity.$inferSelect, keyof typeof activityColumns>;

/**
 * Postgres prints a timestamp without zone as "2026-09-27 08:00:00"; the contract wants ISO local time. No
 * zone math: the wall clock Garmin recorded is the date the runner sees.
 */
function isoLocal(value: string): string {
  return value.replace(" ", "T").slice(0, "YYYY-MM-DDTHH:MM:SS".length);
}

export function toActivity(row: ActivityRow): Activity {
  return { ...row, startUtc: row.startUtc.toISOString(), startLocal: isoLocal(row.startLocal) };
}

/** GET /api/activities/latest: the user's run with the latest start, or null before the first sync. */
export async function getLatestActivity(userId: string): Promise<LatestActivityResponse> {
  const [row] = await db
    .select(activityColumns)
    .from(activity)
    .where(eq(activity.userId, userId))
    // Garmin ids grow over time, so they break a tie between two runs saved with the same start.
    .orderBy(desc(activity.startUtc), desc(activity.garminActivityId))
    .limit(1);
  return { activity: row ? toActivity(row) : null };
}

// The Monday that starts a run's week, from its wall-clock start: date_trunc('week') on a timestamp without
// zone is the ISO week of the date the runner lived, whatever zone the run was in.
const weekOf = sql`date_trunc('week', ${activity.startLocal})`;
const weekStartOf = sql<string>`to_char(${weekOf}, 'YYYY-MM-DD')`;

/**
 * GET /api/activities: the latest `weeks` weeks with runs that start before `before`, whole weeks newest
 * first, each with its runs newest first and its totals. One more week is looked up to tell whether an older
 * page exists; nextBefore is then the oldest week returned.
 */
export async function listActivityWeeks(
  userId: string,
  { before, weeks }: ActivityWeeksQuery,
): Promise<ActivityWeeksResponse> {
  const ofUser = eq(activity.userId, userId);
  const beforeWeek = before === undefined ? undefined : sql`${weekOf} < ${before}::date`;
  const weekRows = await db
    .select({ weekStart: weekStartOf })
    .from(activity)
    .where(and(ofUser, beforeWeek))
    .groupBy(weekOf)
    .orderBy(desc(weekOf))
    .limit(weeks + 1);
  const shown = weekRows.slice(0, weeks).map((row) => row.weekStart);
  const oldest = shown.at(-1);
  if (oldest === undefined) return { weeks: [], nextBefore: null };

  const rows = await db
    .select({ ...activityColumns, weekStart: weekStartOf })
    .from(activity)
    .where(and(ofUser, beforeWeek, sql`${weekOf} >= ${oldest}::date`))
    // Garmin ids grow over time, so they break a tie between two runs saved with the same start.
    .orderBy(desc(activity.startLocal), desc(activity.garminActivityId));

  const byWeek = new Map<string, ActivityWeek>();
  for (const { weekStart, ...row } of rows) {
    let week = byWeek.get(weekStart);
    if (!week) {
      week = { weekStart, distanceM: 0, durationS: 0, runs: [] };
      byWeek.set(weekStart, week);
    }
    week.distanceM += row.distanceM;
    week.durationS += row.durationS;
    week.runs.push(toActivity(row));
  }
  return {
    weeks: [...byWeek.values()],
    nextBefore: weekRows.length > weeks ? oldest : null,
  };
}
