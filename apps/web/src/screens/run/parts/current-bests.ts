import type { DistanceKey, RunBestEffort } from "@running-coach/shared";
import { DISTANCE_KEYS } from "@/lib/distance-labels";

/**
 * The distances at which this run is the runner's current best, shortest first whatever order the efforts
 * come in, for the PB chip ("PB 5K, 10K").
 */
export function currentBests(efforts: readonly RunBestEffort[]): DistanceKey[] {
  const bests = new Set(
    efforts.filter((effort) => effort.personalBest).map((effort) => effort.distanceKey),
  );
  return DISTANCE_KEYS.filter((key) => bests.has(key));
}
