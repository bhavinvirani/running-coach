import {
  distanceInUnits,
  type Goal,
  type PaceZone,
  type PlanWarning,
  type Units,
} from "@running-coach/shared";
import { distanceLabel } from "@/lib/distance-labels";
import { formatCount, formatDistance, formatLocalDate, formatRecordTime } from "@/lib/format";

/** Every sentence and label on Plan, so the wording is read and changed in one place. */
export const planCopy = {
  title: "Plan",
  loading: "Loading your plan",
  /** No goal yet: the sentence carries the one Set goal. */
  empty: "Set a goal to get a training plan.",
  setGoal: "Set goal",
  goal: "Goal",
  changeGoal: "Change goal",
  paces: "Paces",
  notes: "Plan notes",
  weeks: "Weeks",
  /** Said after a week's name to a screen reader; on screen the selected border says it. */
  thisWeek: "this week",
} as const;

const PACE_ZONE_NAMES: Readonly<Record<PaceZone, string>> = {
  easy: "Easy",
  marathon: "Marathon",
  threshold: "Threshold",
  interval: "Interval",
  repetition: "Repetition",
  race: "Race",
};

export function paceZoneName(zone: PaceZone): string {
  return PACE_ZONE_NAMES[zone];
}

/** The goal card's figure: the race distance, or Fitness. */
export function goalHeadline(goal: Goal): string {
  return goal.kind === "race" && goal.distanceKey !== null
    ? distanceLabel(goal.distanceKey)
    : "Fitness";
}

/**
 * The facts under the goal's figure: race day and target time, or the distance a fitness plan is shaped
 * around, then the plan's length and the runs a week.
 */
export function goalFacts(goal: Goal, weeks: number): string[] {
  const goalFacts =
    goal.kind === "race"
      ? [
          goal.raceDate === null ? null : `Race on ${formatLocalDate(goal.raceDate)}`,
          goal.targetTimeS === null ? null : `Target ${formatRecordTime(goal.targetTimeS)}`,
        ]
      : [goal.distanceKey === null ? null : `${distanceLabel(goal.distanceKey)} focus`];
  return [
    ...goalFacts,
    formatCount(weeks, "week", "weeks"),
    formatCount(goal.daysPerWeek, "run a week", "runs a week"),
  ].filter((fact) => fact !== null);
}

function distance(meters: number, units: Units): string {
  return formatDistance(distanceInUnits(meters, units), units);
}

/** One sentence per thing the engine did its best with: what it means for the plan, with the numbers. */
export function warningSentence(warning: PlanWarning, units: Units): string {
  switch (warning.code) {
    case "race_date_close":
      return `The race is ${formatCount(warning.weeks, "week", "weeks")} away, under the ${formatCount(warning.minimumWeeks, "week", "weeks")} a plan for it usually takes: this plan is the taper and what fits before it.`;
    case "no_recent_runs":
      return `No runs in the last 4 weeks, so the plan starts from ${distance(warning.startVolumeM, units)} a week.`;
    case "long_run_short":
      return `The long run peaks at ${distance(warning.peakLongRunM, units)}, under the ${distance(warning.requiredLongRunM, units)} this race usually asks for, so that each week's increase stays safe.`;
    case "target_time_ambitious":
      return `Your target of ${formatRecordTime(warning.targetTimeS)} is well ahead of the ${formatRecordTime(warning.predictedTimeS)} your recent times predict, so the paces follow the prediction.`;
  }
}
