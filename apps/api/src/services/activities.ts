import type { Activity, LatestActivityResponse } from "@running-coach/shared";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { activity } from "../db/schema";

const columns = {
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
  elevationGainM: activity.elevationGainM,
  isIndoor: activity.isIndoor,
  isManual: activity.isManual,
};

type ActivityRow = Pick<typeof activity.$inferSelect, keyof typeof columns>;

/**
 * Postgres prints a timestamp without zone as "2026-09-27 08:00:00"; the contract wants ISO local time. No
 * zone math: the wall clock Garmin recorded is the date the runner sees.
 */
function isoLocal(value: string): string {
  return value.replace(" ", "T").slice(0, "YYYY-MM-DDTHH:MM:SS".length);
}

function toActivity(row: ActivityRow): Activity {
  return { ...row, startUtc: row.startUtc.toISOString(), startLocal: isoLocal(row.startLocal) };
}

/** GET /api/activities/latest: the user's run with the latest start, or null before the first sync. */
export async function getLatestActivity(userId: string): Promise<LatestActivityResponse> {
  const [row] = await db
    .select(columns)
    .from(activity)
    .where(eq(activity.userId, userId))
    // Garmin ids grow over time, so they break a tie between two runs saved with the same start.
    .orderBy(desc(activity.startUtc), desc(activity.garminActivityId))
    .limit(1);
  return { activity: row ? toActivity(row) : null };
}
