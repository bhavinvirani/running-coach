import {
  distanceInUnits,
  isGpsGlitch,
  paceSecondsPerUnit,
  type Units,
} from "@running-coach/shared";
import { formatCount } from "@/lib/format";

/** One lap in the user's unit, as LapsChart and SplitBars draw it. Build it with toLapPoint. */
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

/** The line under a lap chart that names what it left out: "1 lap left out as a GPS glitch."; null for none. */
export function glitchCaption(laps: readonly LapPoint[]): string | null {
  const count = laps.filter((lap) => lap.gpsGlitch).length;
  if (count === 0) return null;
  return `${formatCount(count, "lap", "laps")} left out as ${count === 1 ? "a GPS glitch" : "GPS glitches"}.`;
}
