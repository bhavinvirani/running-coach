import { distanceKeySchema, type DistanceKey } from "@running-coach/shared";

/** Every distance the app knows, shortest first, as the contract orders them. */
export const DISTANCE_KEYS: readonly DistanceKey[] = distanceKeySchema.options;

/**
 * The one place a distance key becomes a word. Fixed labels, not the runner's unit: a 5K is a 5K and a
 * mile is a mile whether the app shows km or mi.
 */
export const DISTANCE_LABELS: Readonly<Record<DistanceKey, string>> = {
  "1k": "1K",
  "1mi": "1 mi",
  "2mi": "2 mi",
  "5k": "5K",
  "5mi": "5 mi",
  "10k": "10K",
  "15k": "15K",
  "10mi": "10 mi",
  "20k": "20K",
  half: "Half",
  marathon: "Marathon",
};

export function distanceLabel(key: DistanceKey): string {
  return DISTANCE_LABELS[key];
}

/**
 * The PB chip's words for the distances a run holds as current bests, already shortest first:
 * ["5k", "10k"] → "PB 5K, 10K". Null for a run that holds none. The chip and the rows' screen-reader
 * names read it from here, so they never disagree.
 */
export function personalBestName(distances: readonly DistanceKey[]): string | null {
  return distances.length === 0 ? null : `PB ${distances.map(distanceLabel).join(", ")}`;
}
