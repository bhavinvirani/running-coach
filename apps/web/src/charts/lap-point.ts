import {
  distanceInUnits,
  isGpsGlitch,
  paceSecondsPerUnit,
  type Units,
} from "@running-coach/shared";

/** One lap in the user's unit, as LapsChart draws it. Build it with toLapPoint. */
export type LapPoint = {
  /** Lap number as the watch shows it, starting at 1. */
  index: number;
  /** Null when the lap has no distance (treadmill without a footpod). */
  paceSecondsPerUnit: number | null;
  distanceInUnit: number;
  /** Faster than any human run, so the GPS jumped: left out of the chart, named in the table. */
  gpsGlitch: boolean;
};

/**
 * Converts a lap as the API stores it (meters, seconds) at the UI edge. The glitch test runs on the SI
 * values through the shared isGpsGlitch, so the rule has one implementation whatever the unit.
 */
export function toLapPoint(
  lap: { index: number; distanceM: number; durationS: number },
  unit: Units,
): LapPoint {
  return {
    index: lap.index,
    paceSecondsPerUnit: paceSecondsPerUnit(lap.distanceM, lap.durationS, unit),
    distanceInUnit: distanceInUnits(lap.distanceM, unit),
    gpsGlitch: isGpsGlitch(lap.distanceM, lap.durationS),
  };
}
