import {
  distanceInUnits,
  elevationInUnits,
  paceSecondsPerUnit,
  type Units,
} from "@running-coach/shared";
import { formatDistance, formatElevation, formatPace } from "@/lib/format";

/** One fixed run, 10 km in 55:00 with 120 m of climb, so each unit's line shows the same run. */
const EXAMPLE = { distanceM: 10_000, durationS: 3_300, climbM: 120 } as const;

/** The example run in a unit: "10.0 km at 5:30 /km, 120 m climb". */
export function exampleRun(units: Units): string {
  const distance = formatDistance(distanceInUnits(EXAMPLE.distanceM, units), units);
  const pace = formatPace(paceSecondsPerUnit(EXAMPLE.distanceM, EXAMPLE.durationS, units), units);
  const climb = formatElevation(elevationInUnits(EXAMPLE.climbM, units), units);
  return `${distance} at ${pace}, ${climb} climb`;
}
