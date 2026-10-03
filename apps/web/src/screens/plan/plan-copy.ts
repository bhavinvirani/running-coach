import {
  DISTANCE_METERS,
  distanceInUnits,
  type Goal,
  type PaceZone,
  type PlanPaces,
  type PlanWarning,
  type Units,
} from "@running-coach/shared";
import { distanceLabel, raceName } from "@/lib/distance-labels";
import {
  formatCount,
  formatCountValue,
  formatDistance,
  formatLocalDate,
  formatRecordTime,
} from "@/lib/format";
import { bandFinishTimeS, formatPlanPace } from "@/lib/pace-band";

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

/**
 * The goal card's figure: the plan's weeks still to run, "20" and "weeks" (for a race, the weeks until it;
 * a fitness plan shows its 12 before it starts).
 */
export function goalWeeks(weeks: number): { value: string; unit: string } {
  return { value: formatCountValue(weeks), unit: weeks === 1 ? "week" : "weeks" };
}

/**
 * The facts under the figure: the race by name and its day, or Fitness and the distance its sessions are
 * shaped around, then the runs a week: "Half marathon · Race on 21 Feb 2027 · 4 runs a week".
 */
export function goalFacts(goal: Goal): string[] {
  const facts =
    goal.kind === "race"
      ? [
          goal.distanceKey === null ? null : raceName(goal.distanceKey),
          goal.raceDate === null ? null : `Race on ${formatLocalDate(goal.raceDate)}`,
        ]
      : ["Fitness", goal.distanceKey === null ? null : `${distanceLabel(goal.distanceKey)} focus`];
  return [...facts, formatCount(goal.daysPerWeek, "run a week", "runs a week")].filter(
    (fact) => fact !== null,
  );
}

/**
 * The goal's speed, the line under its facts: the target the runner set, then the race pace the plan
 * trains at and the finish time that pace means over the goal's distance (a fitness plan's shape, 10K
 * when it has none). The paces come from the runner's recent times, not the target, so a target far ahead
 * of them shows next to the time the plan actually builds to: "Target 1:43:00 · Race pace 5:30-5:36 /km,
 * about 1:57:05".
 */
export function goalPaceFacts(goal: Goal, paces: PlanPaces, units: Units): string[] {
  const distanceM = DISTANCE_METERS[goal.distanceKey ?? "10k"];
  const finish = formatRecordTime(bandFinishTimeS(paces.race, distanceM));
  const target =
    goal.kind === "race" && goal.targetTimeS !== null
      ? `Target ${formatRecordTime(goal.targetTimeS)}`
      : null;
  return [target, `Race pace ${formatPlanPace(paces.race, units)}, about ${finish}`].filter(
    (fact) => fact !== null,
  );
}

function distance(meters: number, units: Units): string {
  return formatDistance(distanceInUnits(meters, units), units);
}

/**
 * One sentence per thing the engine did its best with: what it means for the plan, with the numbers.
 * `daysPerWeek` is the goal's, which a lifted start volume is measured against.
 */
export function warningSentence(warning: PlanWarning, units: Units, daysPerWeek: number): string {
  switch (warning.code) {
    case "race_date_close":
      return `The race is ${formatCount(warning.weeks, "week", "weeks")} away, under the ${formatCount(warning.minimumWeeks, "week", "weeks")} a plan for it usually takes: this plan is the taper and what fits before it.`;
    case "no_recent_runs":
      return `No runs in the last 4 weeks, so the plan starts from ${distance(warning.startVolumeM, units)} a week.`;
    case "start_volume_lifted":
      return `Your recent ${distance(warning.recentWeeklyM, units)} a week is under what ${formatCount(daysPerWeek, "run", "runs")} need, so the plan starts at ${distance(warning.startVolumeM, units)}.`;
    case "long_run_short":
      return `The long run peaks at ${distance(warning.peakLongRunM, units)}, under the ${distance(warning.requiredLongRunM, units)} this race usually asks for, so that each week's increase stays safe.`;
    case "target_time_ambitious":
      return `Your target of ${formatRecordTime(warning.targetTimeS)} is well ahead of the ${formatRecordTime(warning.predictedTimeS)} your recent times predict, so the paces follow the prediction.`;
  }
}
