import type { Weekday } from "@running-coach/shared";
import { RACE_PRACTICE_MIN_DAYS_BEFORE_RACE } from "../constants";
import { addDays, daysBetween, weekdayIndex } from "../dates";
import { isSpacedFromHardDay } from "./hard-days";

export interface RaceWeekDaysInput {
  /** The race week's Monday. */
  weekStart: string;
  raceDate: string;
  longRunDay: Weekday;
  daysPerWeek: number;
  /** Last week's last hard day, null in a plan that starts in race week. */
  lastHardDate: string | null;
}

export interface TaperPracticeInput {
  /** Quality days of the week before the race week that fall in the 7 days before the race. */
  qualityDates: readonly string[];
  raceDate: string;
  /** The race week's own race practice, null with none. */
  raceWeekPracticeDate: string | null;
}

export interface RaceWeekDays {
  racePracticeDate: string | null;
  /** In fill order. */
  easyDates: string[];
}

// Days after the long-run weekday, as in an ordinary week, with the long-run day itself free this week.
const EASY_OFFSETS = [3, 5, 1, 6, 0, 2, 4];

/**
 * The race week's running days: everything before the day before the race, which is rest. Race practice
 * sits 3 days before the race when that is 48 h after last week's last hard day; the race counts as one
 * of the week's days.
 */
export function raceWeekDays({
  weekStart,
  raceDate,
  longRunDay,
  daysPerWeek,
  lastHardDate,
}: RaceWeekDaysInput): RaceWeekDays {
  const raceIndex = daysBetween(weekStart, raceDate);
  if (raceIndex < 0 || raceIndex > 6) {
    throw new RangeError(`The race ${raceDate} is not in the week of ${weekStart}`);
  }
  const practiceIndex = raceIndex - RACE_PRACTICE_MIN_DAYS_BEFORE_RACE;
  const racePracticeDate =
    practiceIndex >= 0 &&
    isSpacedFromHardDay({ lastHardDate, date: addDays(weekStart, practiceIndex) })
      ? addDays(weekStart, practiceIndex)
      : null;
  const longRun = weekdayIndex(longRunDay);
  const easyDates = EASY_OFFSETS.map((offset) => (longRun + offset) % 7)
    .filter((index) => index <= raceIndex - 2)
    .map((index) => addDays(weekStart, index))
    .filter((date) => date !== racePracticeDate)
    .slice(0, daysPerWeek - 1 - (racePracticeDate === null ? 0 : 1));
  return { racePracticeDate, easyDates };
}

/**
 * The 7 days before the race hold one race practice at most, at least 3 days out. When they reach into
 * the week before the race week (a race early in the week), that week's quality day there stays race
 * practice only if the race week holds none: the latest one at least 3 days out. The others run easy.
 */
export function taperPracticeDate({
  qualityDates,
  raceDate,
  raceWeekPracticeDate,
}: TaperPracticeInput): string | null {
  if (raceWeekPracticeDate !== null) return null;
  const farEnough = qualityDates
    .filter((date) => daysBetween(date, raceDate) >= RACE_PRACTICE_MIN_DAYS_BEFORE_RACE)
    .sort((a, b) => daysBetween(b, a));
  return farEnough.at(-1) ?? null;
}
