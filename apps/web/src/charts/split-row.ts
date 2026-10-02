import { SHORT_LAP_IN_UNITS, formatLapDistanceValue } from "@/lib/format";
import type { LapPoint } from "./lap-point";

/**
 * The narrowest bar, in percent of its column: a pace as wide as "15:00 /km" written inside still fits at
 * 390 px. Only a lap about two and a half times slower than the fastest reaches it, which is a walk; its
 * pace is in the label, so the bar stops saying how much slower and the number says it instead.
 */
export const MIN_BAR_PERCENT = 40;

/** One lap as SplitBars draws it. Build them with toSplitRows. */
export type SplitRow = {
  /** Lap number as the watch shows it, starting at 1. */
  index: number;
  /** The first column: the lap number, or for a short last lap its distance, "0.04". */
  label: string;
  /** Null when the lap has no distance (treadmill without a footpod). */
  paceSecondsPerUnit: number | null;
  gpsGlitch: boolean;
  /** The bar's width in percent of its column; null when the lap has no bar (GPS glitch, no pace). */
  barPercent: number | null;
  /**
   * The previous lap's pace minus this one's, in whole seconds per unit: positive when this lap was faster.
   * Null for the first lap, for a lap without a bar and for the lap after one: there is nothing to compare.
   */
  deltaSeconds: number | null;
};

function barPace(lap: LapPoint): number | null {
  return lap.gpsGlitch ? null : lap.paceSecondsPerUnit;
}

/**
 * Lap points to split rows: the fastest lap that is no GPS glitch is full width, each other lap's width is
 * its speed against that lap's (fastest pace / lap pace). The delta compares the paces as the bars print
 * them, rounded to the second, so two laps that both read 5:09 differ by 0:00 and never by -0:01.
 */
export function toSplitRows(laps: readonly LapPoint[]): SplitRow[] {
  const paces = laps.map(barPace).filter((pace) => pace !== null);
  const fastest = paces.length > 0 ? Math.min(...paces) : null;

  return laps.map((lap, position) => {
    const pace = barPace(lap);
    const previous = position > 0 ? barPace(laps[position - 1] as LapPoint) : null;
    // Only a last lap cut short by the end of the run (shorter than the lap before it): a watch that
    // auto-laps every km shown in miles has every lap at 0.62, and those are still laps 1, 2, 3.
    const before = position > 0 ? laps[position - 1] : undefined;
    const short =
      position === laps.length - 1 &&
      before !== undefined &&
      lap.distanceInUnit > 0 &&
      lap.distanceInUnit < SHORT_LAP_IN_UNITS * before.distanceInUnit &&
      lap.distanceInUnit < SHORT_LAP_IN_UNITS;
    return {
      index: lap.index,
      label: short ? formatLapDistanceValue(lap.distanceInUnit) : String(lap.index),
      paceSecondsPerUnit: lap.paceSecondsPerUnit,
      gpsGlitch: lap.gpsGlitch,
      barPercent:
        pace === null || fastest === null
          ? null
          : Math.max(MIN_BAR_PERCENT, Math.round((fastest / pace) * 100)),
      deltaSeconds:
        pace === null || previous === null ? null : Math.round(previous) - Math.round(pace),
    };
  });
}
