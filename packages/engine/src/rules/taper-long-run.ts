import type { RaceDistanceKey } from "@running-coach/shared";
import { LONG_RUN_MIN_DAYS_BEFORE_RACE, TAPER_LONG_RUN_SHARES } from "../constants";

export interface TaperLongRunInput {
  distanceKey: RaceDistanceKey;
  /** Days from the long run's date to the race. */
  daysOut: number;
  /** The largest long run built before the long run's week, else the baseline's longest. */
  peakLongRunM: number;
}

/** The long run keeps its day until 6 days before the race; in the last 5 days that day is the race week's. */
export function longRunKeepsDay(daysOut: number): boolean {
  return daysOut >= LONG_RUN_MIN_DAYS_BEFORE_RACE;
}

/**
 * The long run's cap by its days to the race, in whole meters: 70% of the peak long run 6 to 13 days out
 * (a marathon's 60%), a marathon's 80% 14 to 20 days out, 0 in the last 5 days, where there is none;
 * null further out, where only its other caps (share, 150 min, 110%) hold. The caps hold in any week,
 * a taper week or the week before it.
 */
export function taperLongRunCapM({
  distanceKey,
  daysOut,
  peakLongRunM,
}: TaperLongRunInput): number | null {
  if (!longRunKeepsDay(daysOut)) return 0;
  const band = TAPER_LONG_RUN_SHARES[distanceKey].find((b) => daysOut <= b.maxDaysOut);
  return band === undefined ? null : Math.floor(band.share * peakLongRunM);
}
