import type { DistanceKey, RunBestEffort } from "@running-coach/shared";
import { DISTANCE_KEYS } from "@/lib/distance-labels";

/** The efforts shortest first whatever order they arrive in, so the rows and the PB chip follow distance. */
export function inDistanceOrder(efforts: readonly RunBestEffort[]): RunBestEffort[] {
  return [...efforts].sort(
    (a, b) => DISTANCE_KEYS.indexOf(a.distanceKey) - DISTANCE_KEYS.indexOf(b.distanceKey),
  );
}

/** The distances at which this run is the runner's current best, in the order given, for the PB chip. */
export function currentBests(efforts: readonly RunBestEffort[]): DistanceKey[] {
  return efforts.filter((effort) => effort.personalBest).map((effort) => effort.distanceKey);
}
