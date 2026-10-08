import type { RaceDistanceKey } from "@running-coach/shared";
import { RACE_BAND_MAX_DAYS_OUT, TAPER_ANCHOR_WEEKDAY, TAPER_SHARES } from "../constants";
import { addDays, daysBetween, mondayOf } from "../dates";

export interface TaperWeekInput {
  raceDate: string;
  /** The week's Monday. */
  weekStart: string;
}

export interface TaperShareInput extends TaperWeekInput {
  distanceKey: RaceDistanceKey;
}

/** Days from the week's Thursday to the race; negative when the race is before that Thursday. */
export function thursdayDaysOut({ weekStart, raceDate }: TaperWeekInput): number {
  return daysBetween(addDays(weekStart, TAPER_ANCHOR_WEEKDAY), raceDate);
}

/**
 * The share of the taper peak a Monday-to-Sunday week may hold, the race excluded, from its Thursday's
 * days to the race: 40% when its Thursday is 6 or fewer days out (the race week, and the week before a
 * Monday to Wednesday race), 70% at 7 to 13 (marathon 60%), a marathon's 80% at 14 to 20; null for a
 * week before the taper. A ceiling, not a target: the week's sessions decide what it runs.
 */
export function taperShare(input: TaperShareInput): number | null {
  const daysOut = thursdayDaysOut(input);
  return TAPER_SHARES[input.distanceKey].find((band) => daysOut <= band.maxDaysOut)?.share ?? null;
}

/** The most a taper week may run, the race excluded: its share of the taper peak in whole meters. */
export function taperCeilingM(input: TaperShareInput & { peakM: number }): number | null {
  const share = taperShare(input);
  return share === null ? null : Math.floor(share * input.peakM);
}

/** The race band: the week whose Thursday is 6 or fewer days out, whatever the distance. */
export function isRaceBandWeek(input: TaperWeekInput): boolean {
  return thursdayDaysOut(input) <= RACE_BAND_MAX_DAYS_OUT;
}

/**
 * The calendar weeks that taper, the race week included: the weeks with a band, counted back from the
 * race week. A Monday to Wednesday race has one more than a later one, as its week before is in the race
 * band too.
 */
export function taperWeekCount({
  distanceKey,
  raceDate,
}: {
  distanceKey: RaceDistanceKey;
  raceDate: string;
}): number {
  const raceWeekStart = mondayOf(raceDate);
  let weeks = 0;
  while (
    taperShare({ distanceKey, raceDate, weekStart: addDays(raceWeekStart, -7 * weeks) }) !== null
  ) {
    weeks += 1;
  }
  return weeks;
}
