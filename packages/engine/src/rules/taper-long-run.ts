import type { RaceDistanceKey, Weekday } from "@running-coach/shared";
import { LONG_RUN_MIN_DAYS_BEFORE_RACE, TAPER_LONG_RUN_SHARES } from "../constants";
import { addDays, daysBetween, weekdayIndex } from "../dates";

export interface TaperLongRunInput {
  distanceKey: RaceDistanceKey;
  /** Days from the long run's date to the race. */
  daysOut: number;
  /** The largest long run built before the long run's week, else the baseline's longest. */
  peakLongRunM: number;
}

export interface TaperLongRunBandsInput {
  distanceKey: RaceDistanceKey;
  /** Days from the long run's date to the race. */
  daysOut: number;
}

export interface LongRunDayCapInput {
  distanceKey: RaceDistanceKey;
  /** Null for a plan with no race. */
  raceDate: string | null;
  longRunDay: Weekday;
  /** The week's Monday. */
  weekStart: string;
  /** Every long run before the week, as built. */
  longRunsBeforeM: readonly number[];
  /** The baseline's longest run, never under the 5 km floor. */
  seedM: number;
}

export interface WeekRunCapsInput extends LongRunDayCapInput {
  /** 110% of the longest run of the last 4 weeks. */
  runCapM: number;
  /** 20 min at the easy midpoint. */
  minRunM: number;
}

export interface WeekRunCaps {
  /** No run of the week over this. */
  maxRunM: number;
  /** False where the long run's cap by days to the race is under 20 min: its day runs easy. */
  longRun: boolean;
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

/**
 * Whether a long run this many days before the race is under its cap by days to the race: inside
 * its distance's last band (13 days out, a marathon's 20) or closer, where taperLongRunCapM gives a
 * cap.
 */
export function inTaperLongRunBands({ distanceKey, daysOut }: TaperLongRunBandsInput): boolean {
  return daysOut <= Math.max(...TAPER_LONG_RUN_SHARES[distanceKey].map((band) => band.maxDaysOut));
}

/**
 * The cap a race plan's week puts on its runs by its long run's days to the race
 * (taperLongRunCapM): a share of the largest long run before the week, else the baseline's longest.
 * A week whose long-run day is 5 or fewer days out, the race week's, caps its runs as a long run 6
 * days out would. Null with no race, or a long run further out.
 */
export function longRunDayCapM({
  distanceKey,
  raceDate,
  longRunDay,
  weekStart,
  longRunsBeforeM,
  seedM,
}: LongRunDayCapInput): number | null {
  if (raceDate === null) return null;
  const longDate = addDays(weekStart, weekdayIndex(longRunDay));
  return taperLongRunCapM({
    distanceKey,
    daysOut: Math.max(daysBetween(longDate, raceDate), LONG_RUN_MIN_DAYS_BEFORE_RACE),
    peakLongRunM: longRunsBeforeM.length === 0 ? seedM : Math.max(...longRunsBeforeM),
  });
}

/**
 * What a week holds its runs to: 110% of the recent longest and, in a race plan, its long run's cap
 * by days to the race (longRunDayCapM). Where that cap is under 20 min the week runs no long run,
 * which would be shorter than its easy runs, and its other runs hold to 20 min instead: no run
 * passes what the long run would have been allowed by more than the 20 min minimum.
 */
export function weekRunCaps({ runCapM, minRunM, ...dayCap }: WeekRunCapsInput): WeekRunCaps {
  const dayCapM = longRunDayCapM(dayCap);
  return {
    maxRunM: Math.min(runCapM, Math.max(dayCapM ?? Infinity, minRunM)),
    longRun: dayCapM === null || dayCapM >= minRunM,
  };
}
