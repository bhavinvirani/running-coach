import type { DistanceKey } from "@running-coach/shared";
import { DISTANCE_KEYS } from "@/lib/distance-labels";

/**
 * The order of a best-effort row: the longest distance first, as a runner reads their bests, and the
 * distances without a time ("No run yet") after every one with a time, longest first among themselves too,
 * so the whole row reads one way. A new array; the one given is left alone.
 */
export function longestFirst<T extends { distanceKey: DistanceKey }>(
  items: readonly T[],
  hasTime: (item: T) => boolean = () => true,
): T[] {
  const rank = (item: T) => DISTANCE_KEYS.indexOf(item.distanceKey);
  return [...items].sort((a, b) => Number(hasTime(b)) - Number(hasTime(a)) || rank(b) - rank(a));
}
