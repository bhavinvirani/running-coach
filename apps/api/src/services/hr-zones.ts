import {
  bpmAtPercentOfMaxHr,
  DEFAULT_HR_ZONE_FLOOR_PERCENTS,
  type HrZones,
  type HrZonesResponse,
  hrZonesSchema,
  MAX_MAX_HR,
  MIN_MAX_HR,
} from "@running-coach/shared";
import { and, desc, eq, gte, isNotNull, max } from "drizzle-orm";
import { db } from "../db/client";
import { activity, activityStream, userSettings } from "../db/schema";
import { logger } from "../lib/logger";
import type { Executor } from "./runner-state";

// The heart-rate zones in use (SPEC: user_settings.hr_zones): the runner's own when saved, else Garmin's
// as the newest run with stored zones carries them, else Garmin's default shares of the highest recent max
// HR. No Garmin call: Garmin sends its zones with each run's detail.

const log = logger.child({ module: "hr-zones" });

/** How far back the highest max HR is looked for when no run carries Garmin's zones. */
const ESTIMATE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const ZONE_5_FLOOR_PERCENT = DEFAULT_HR_ZONE_FLOOR_PERCENTS[4];

function clampMaxHr(bpm: number): number {
  return Math.min(MAX_MAX_HR, Math.max(MIN_MAX_HR, Math.round(bpm)));
}

/**
 * The zones the runner saved, or null for Garmin's. A stored value outside the contract (written before a
 * rule changed) counts as none, so run detail keeps answering; it is logged by ids only.
 */
async function customZones(executor: Executor, userId: string): Promise<HrZones | null> {
  const [row] = await executor
    .select({ hrZones: userSettings.hrZones })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  if (!row || row.hrZones === null) return null;
  const parsed = hrZonesSchema.safeParse(row.hrZones);
  if (parsed.success) return parsed.data;
  log.warn({ userId }, "stored heart-rate zones do not parse; using Garmin's");
  return null;
}

/** The floors of the runner's own zones, zone 1 first, or null while Garmin's are in use (run detail). */
export async function customHrZoneFloors(
  userId: string,
  executor: Executor = db,
): Promise<HrZones["lowBpm"] | null> {
  return (await customZones(executor, userId))?.lowBpm ?? null;
}

/**
 * Garmin's zones as the user's newest run with stored zones carries them (the watch's zone settings when
 * it ran). Garmin sends no max HR, so it is read back from zone 5's floor at Garmin's default 90%: a run's
 * own max HR can sit below that floor or be an optical spike. Null without such a run, or when its floors
 * do not make five rising zones.
 */
async function garminZones(userId: string): Promise<HrZones | null> {
  const [row] = await db
    .select({ activityId: activity.id, zones: activityStream.hrZones })
    .from(activityStream)
    .innerJoin(activity, eq(activity.id, activityStream.activityId))
    .where(and(eq(activity.userId, userId), isNotNull(activityStream.hrZones)))
    .orderBy(desc(activity.startUtc), desc(activity.garminActivityId))
    .limit(1);
  if (!row?.zones) return null;
  const lowBpm = [...row.zones]
    .sort((a, b) => a.zone - b.zone)
    .map((zone) => Math.round(zone.lowBpm));
  const zone5 = lowBpm[4];
  const parsed = hrZonesSchema.safeParse({
    maxHr: zone5 === undefined ? null : clampMaxHr((zone5 * 100) / ZONE_5_FLOOR_PERCENT),
    lowBpm,
  });
  if (parsed.success) return parsed.data;
  log.info(
    { userId, activityId: row.activityId },
    "Garmin's stored zones are unusable; estimating",
  );
  return null;
}

/** Garmin's default shares of the highest max HR of the runs that started in the last 365 days. */
async function estimatedZones(userId: string, now: Date): Promise<HrZones | null> {
  const [row] = await db
    .select({ peak: max(activity.maxHr) })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        gte(activity.startUtc, new Date(now.getTime() - ESTIMATE_WINDOW_MS)),
      ),
    );
  const peak = row?.peak ?? null;
  if (peak === null) return null;
  const maxHr = clampMaxHr(peak);
  return hrZonesSchema.parse({
    maxHr,
    lowBpm: DEFAULT_HR_ZONE_FLOOR_PERCENTS.map((percent) => bpmAtPercentOfMaxHr(percent, maxHr)),
  });
}

/** GET /api/hr-zones: the zones in use and where they come from (hrZonesSourceSchema). */
export async function getHrZones(userId: string, now = new Date()): Promise<HrZonesResponse> {
  const custom = await customZones(db, userId);
  if (custom) return { source: "custom", zones: custom };
  const garmin = await garminZones(userId);
  if (garmin) return { source: "garmin", zones: garmin };
  const estimated = await estimatedZones(userId, now);
  if (estimated) return { source: "estimated", zones: estimated };
  return { source: "none", zones: null };
}

/** PUT /api/hr-zones: saves the runner's own zones, which run detail then uses for every run. */
export async function saveHrZones(userId: string, zones: HrZones): Promise<HrZonesResponse> {
  await db.update(userSettings).set({ hrZones: zones }).where(eq(userSettings.userId, userId));
  log.info({ userId }, "custom heart-rate zones saved");
  return getHrZones(userId);
}

/** DELETE /api/hr-zones: Reset to Garmin's. A second reset changes nothing. */
export async function resetHrZones(userId: string): Promise<HrZonesResponse> {
  await db.update(userSettings).set({ hrZones: null }).where(eq(userSettings.userId, userId));
  log.info({ userId }, "heart-rate zones reset to Garmin's");
  return getHrZones(userId);
}
