import { distanceInUnits, type Shoe, type Units } from "@running-coach/shared";
import { formatDistance, formatDistanceValue, formatWholeDistance } from "@/lib/format";

export const shoesCopy = {
  title: "Shoes",
  loading: "Loading shoes",
  inUse: "In use",
  retired: "Retired",
  active: "Active",
  noneInUse: "No pair in use, so new runs get no shoes. Add shoes or make a retired pair active.",
  empty: "Add your shoes to see how far each pair has run.",
  add: "Add shoes",
} as const;

/** "312.4 of 650 km": the distance to a tenth like any distance, the goal in whole units as it was typed. */
export function distanceOfGoal(shoe: Shoe, units: Units): string {
  const distance = formatDistanceValue(distanceInUnits(shoe.distanceM, units));
  return `${distance} of ${formatWholeDistance(distanceInUnits(shoe.retireDistanceM, units), units)}`;
}

/**
 * For a pair at or past its retire distance, how far past in words, since the full bar alone would say it
 * by length: "52.3 km past its retire distance". Null before the goal.
 */
export function pastGoalLine(shoe: Shoe, units: Units): string | null {
  const overM = shoe.distanceM - shoe.retireDistanceM;
  if (overM < 0) return null;
  const over = distanceInUnits(overM, units);
  // Under a twentieth of a unit past would read "0.0 km past".
  return formatDistanceValue(over) === "0.0"
    ? "At its retire distance"
    : `${formatDistance(over, units)} past its retire distance`;
}
