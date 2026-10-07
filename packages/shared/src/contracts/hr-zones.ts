import { z } from "zod";

/**
 * Garmin's default zones start at these shares of max HR, zone 1 to 5. Zones are estimated from them
 * before any run carries Garmin's own, and Garmin's max HR is read back from its zone 5 floor.
 */
export const DEFAULT_HR_ZONE_FLOOR_PERCENTS = [50, 60, 70, 80, 90] as const;

export const MIN_MAX_HR = 100;
export const MAX_MAX_HR = 240;
export const MIN_ZONE_FLOOR_BPM = 30;

const bpmSchema = z.number().int();

/**
 * Five heart-rate zones as their lower bounds in bpm, zone 1 first, and the max HR their percentages
 * are of. A zone ends where the next one starts; zone 5 ends at max HR, and time below zone 1 counts in
 * no zone, as on Garmin.
 */
export const hrZonesSchema = z
  .object({
    maxHr: bpmSchema.min(MIN_MAX_HR).max(MAX_MAX_HR),
    lowBpm: z.tuple([bpmSchema, bpmSchema, bpmSchema, bpmSchema, bpmSchema]),
  })
  .strict()
  .refine((zones) => zones.lowBpm[0] >= MIN_ZONE_FLOOR_BPM, {
    message: `Zone 1 starts at ${MIN_ZONE_FLOOR_BPM} bpm or more`,
    path: ["lowBpm", 0],
  })
  .refine((zones) => zones.lowBpm.every((bpm, i) => i === 0 || bpm > zones.lowBpm[i - 1]!), {
    message: "Each zone starts above the one before it",
    path: ["lowBpm"],
  })
  .refine((zones) => zones.lowBpm[4] < zones.maxHr, {
    message: "Zone 5 starts below max HR",
    path: ["lowBpm", 4],
  });
export type HrZones = z.infer<typeof hrZonesSchema>;

/**
 * Where the zones in use come from. custom: the runner saved them, and run detail computes each run's
 * seconds in zone from its heart-rate series. garmin: the floors on the newest run whose detail is
 * stored, with Garmin's own seconds per run. estimated: no run carries Garmin's zones yet, so the
 * default shares of the highest max HR of the runs in the last 365 days. none: no run has a max HR.
 */
export const hrZonesSourceSchema = z.enum(["custom", "garmin", "estimated", "none"]);
export type HrZonesSource = z.infer<typeof hrZonesSourceSchema>;

/**
 * GET, PUT and DELETE /api/hr-zones. PUT saves custom zones (body: hrZonesSchema); DELETE is Reset to
 * Garmin's. zones is null only when source is none.
 */
export const hrZonesResponseSchema = z
  .object({ source: hrZonesSourceSchema, zones: hrZonesSchema.nullable() })
  .strict();
export type HrZonesResponse = z.infer<typeof hrZonesResponseSchema>;
