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
