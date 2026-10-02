import {
  distanceInUnits,
  elevationInUnits,
  type ActivityStreams,
  type Units,
} from "@running-coach/shared";

export type SeriesKind = "cadence" | "elevation";

/** One sample of a run in the user's unit, as SeriesChart draws it. Build it with toSeriesPoints. */
export type SeriesPoint = {
  /** Distance from the start in km or mi. */
  distanceInUnit: number;
  /** Steps per minute for cadence; meters (km) or feet (mi) for elevation. */
  value: number;
};

/**
 * Converts one series of the run's samples as the API stores them (meters, steps per minute) at the UI
 * edge, paired with the distance of the same row. Missing samples are dropped rather than drawn as zero,
 * and so is a cadence of 0, which is the runner standing still, not a step rate: kept, it would drop the
 * line to the axis at every stop. A series the watch never recorded gives no points.
 */
export function toSeriesPoints(
  streams: ActivityStreams,
  unit: Units,
  kind: SeriesKind,
): SeriesPoint[] {
  const values = kind === "cadence" ? streams.cadence : streams.elevationM;
  if (values === null) return [];
  const rows = Math.min(values.length, streams.distanceM.length);
  const points: SeriesPoint[] = [];
  for (let row = 0; row < rows; row += 1) {
    const value = values[row];
    const distanceM = streams.distanceM[row];
    if (value === null || value === undefined || distanceM === undefined) continue;
    if (!Number.isFinite(value) || (kind === "cadence" && value <= 0)) continue;
    points.push({
      distanceInUnit: distanceInUnits(distanceM, unit),
      value: kind === "cadence" ? value : elevationInUnits(value, unit),
    });
  }
  return points;
}

/** One row of a series' table: the mean over one km or mi of the run. */
export type SeriesStretch = {
  /** Where the stretch ends, in the user's unit: 1, 2, ... and the run's last distance for the remainder. */
  upTo: number;
  average: number;
};

/**
 * The series as one average per whole km or mi, for the table view: a few dozen rows that read like splits,
 * instead of hundreds of samples. A stretch without samples (a GPS gap) is left out.
 */
export function seriesStretches(points: readonly SeriesPoint[]): SeriesStretch[] {
  const stretches = new Map<number, { sum: number; count: number; last: number }>();
  for (const point of points) {
    // Stretch n covers (n, n + 1], so a sample at exactly 10.0 closes the tenth instead of opening an 11th.
    const stretch = Math.max(0, Math.ceil(point.distanceInUnit) - 1);
    const current = stretches.get(stretch) ?? { sum: 0, count: 0, last: 0 };
    current.sum += point.value;
    current.count += 1;
    current.last = Math.max(current.last, point.distanceInUnit);
    stretches.set(stretch, current);
  }
  const lastStretch = Math.max(...stretches.keys());
  return [...stretches.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stretch, { sum, count, last }]) => ({
      upTo: stretch === lastStretch ? last : stretch + 1,
      average: sum / count,
    }));
}
