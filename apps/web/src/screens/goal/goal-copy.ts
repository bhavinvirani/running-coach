import {
  DISTANCE_METERS,
  distanceInUnits,
  paceSecondsPerUnit,
  type DistanceKey,
  type PlanConflict,
  type RaceDistanceKey,
  type Units,
} from "@running-coach/shared";
import { formatCount, formatDistance, formatLocalDate, formatPace } from "@/lib/format";

/** Every sentence and label on the goal form, so the wording is read and changed in one place. */
export const goalCopy = {
  title: "Goal",
  loading: "Loading your goal",
  target: "Target",
  trainingFor: "Training for",
  race: "Race",
  fitness: "Fitness",
  distance: "Distance",
  anyDistance: "Any",
  fitnessDistanceHelp: "The distance the sessions are shaped around.",
  raceDate: "Race date",
  targetTime: "Target time",
  noTarget: "No target",
  week: "Training week",
  daysPerWeek: "Runs a week",
  longRunDay: "Long run day",
  recentRace: "Recent race",
  recentRaceHelp: "A race or time trial from the last few months. It sets your paces.",
  addRecentRace: "Add a recent race time",
  time: "Time",
  save: "Save goal",
  saving: "Saving…",
  pickDistance: "Pick a race distance.",
  pickRaceDate: "Pick a race date.",
  pickTargetTime: "Pick a target time, or tick No target.",
} as const;

/**
 * The caption under a time picker: the pace the time means over its distance, in the runner's unit,
 * "Pace 4:53 /km" for a 1:43:00 half. Null until there is a distance and a time to divide.
 */
export function timePace(
  distanceKey: DistanceKey | null,
  timeS: number,
  units: Units,
): string | null {
  if (distanceKey === null || timeS <= 0) return null;
  return `Pace ${formatPace(paceSecondsPerUnit(DISTANCE_METERS[distanceKey], timeS, units), units)}`;
}

/** A race distance inside a sentence: "a marathon plan", "a half marathon plan", "a 10K plan". */
const RACE_IN_SENTENCE: Readonly<Record<RaceDistanceKey, string>> = {
  "5k": "5K",
  "10k": "10K",
  half: "half marathon",
  marathon: "marathon",
};

/**
 * Why the goal could not be saved, with its numbers and what to change. The engine reports a conflict
 * instead of bending a rule (SPEC), so each sentence names the rule's limit and the way out.
 */
export function conflictSentence(conflict: PlanConflict, units: Units): string {
  switch (conflict.code) {
    case "long_run_cap":
      return `A ${RACE_IN_SENTENCE[conflict.distanceKey]} plan needs at least ${formatCount(conflict.minDaysPerWeek, "running day", "running days")} a week: with ${conflict.daysPerWeek}, the long run would be over the long-run cap. Add a day or pick a shorter race.`;
    case "too_many_days": {
      const runs = formatCount(conflict.daysPerWeek, "run", "runs");
      const pick = `Pick ${formatCount(conflict.maxDaysPerWeek, "day", "days")} or fewer.`;
      if (conflict.baselineWeeklyM === 0) {
        return `With no running in the last 4 weeks, ${runs} a week would build up faster than 10% a week. ${pick}`;
      }
      const baseline = formatDistance(distanceInUnits(conflict.baselineWeeklyM, units), units);
      return `${runs} a week would be more than 10% over the ${baseline} a week you have been running. ${pick}`;
    }
    case "race_too_soon": {
      const start = formatLocalDate(conflict.earliestStart);
      return `The plan would start on ${start}, after the race on ${formatLocalDate(conflict.raceDate)}. Pick a race date on or after ${start}.`;
    }
    case "no_recent_time":
      return "There is no recent race or best effort to set your paces from. Enter a recent race time below.";
  }
}
