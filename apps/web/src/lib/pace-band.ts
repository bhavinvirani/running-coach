import { METERS_PER_KM, metersPerUnit, type PaceBand, type Units } from "@running-coach/shared";
import { formatPaceBand } from "./format";

/**
 * A plan's pace band in the runner's unit: "4:45-4:52 /km" or "7:39-7:50 /mi". The band arrives in seconds
 * per kilometer; seconds per mile are that times a mile's kilometers.
 */
export function formatPlanPace(band: PaceBand, units: Units): string {
  const factor = metersPerUnit(units) / METERS_PER_KM;
  return formatPaceBand(band.fastSPerKm * factor, band.slowSPerKm * factor, units);
}

/**
 * The finish time a pace band implies over a distance, in whole seconds: the middle of the band times the
 * distance. 294-298 s/km over 10 km → 2960, 49:20.
 */
export function bandFinishTimeS(band: PaceBand, distanceM: number): number {
  const middleSPerKm = (band.fastSPerKm + band.slowSPerKm) / 2;
  return Math.round((middleSPerKm * distanceM) / METERS_PER_KM);
}
