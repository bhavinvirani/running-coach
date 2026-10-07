import type { HrZones, HrZoneTime } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { type activity, activityStream } from "../src/db/schema";
import { createRun, nextGarminActivityId } from "./seed";

// Fictional rows for the heart-rate zone tests: stored detail series and Garmin's zones per run.

/** Zones a runner saves in Settings: max HR 200, floors at 100, 120, 140, 160 and 180 bpm. */
export const CUSTOM_ZONES: HrZones = { maxHr: 200, lowBpm: [100, 120, 140, 160, 180] };

/** Garmin's zones as the detail call stores them: these floors, and these seconds (1000 each by default). */
export function garminZones(
  lowBpm: readonly number[],
  seconds: readonly number[] = lowBpm.map(() => 1000),
): HrZoneTime[] {
  return lowBpm.map((floor, i) => ({ zone: i + 1, lowBpm: floor, seconds: seconds[i] ?? 0 }));
}

export interface StoredSeries {
  elapsedS: number[];
  hr: (number | null)[] | null;
  /** Garmin's zones for the run; null when Garmin sent none (a run without heart rate). */
  hrZones?: HrZoneTime[] | null;
  /** Null for an indoor run. */
  route?: [number, number][] | null;
}

function streamValues({ elapsedS, hr, hrZones = null, route = null }: StoredSeries) {
  return {
    elapsedS,
    distanceM: elapsedS.map((s) => s * 3),
    hr,
    cadence: null,
    elevationM: null,
    speedMps: null,
    route,
    hrZones,
  };
}

/** Stores a fetched detail for the run: these samples, no laps. */
export async function storeSeries(activityId: string, series: StoredSeries): Promise<void> {
  await db.insert(activityStream).values({ activityId, ...streamValues(series) });
}

/** Writes a run's stored detail over, as a detail fetched again after the run was edited on Garmin. */
export async function replaceSeries(activityId: string, series: StoredSeries): Promise<void> {
  await db
    .update(activityStream)
    .set(streamValues(series))
    .where(eq(activityStream.activityId, activityId));
}

/** A run of the user's with its own Garmin id and a stored detail of these samples. */
export async function createRunWithSeries(
  userId: string,
  series: StoredSeries,
  values: Partial<Omit<typeof activity.$inferInsert, "userId">> = {},
) {
  const run = await createRun(userId, { garminActivityId: nextGarminActivityId(), ...values });
  await storeSeries(run.id, series);
  return run;
}
