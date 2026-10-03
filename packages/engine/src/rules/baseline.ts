import type {
  PlanBaseline,
  PlanConflict,
  PlanWarning,
  RaceDistanceKey,
} from "@running-coach/shared";
import {
  MIN_DAYS_PER_WEEK,
  RE_ENTRY_DAYS_PER_EMPTY_WEEK,
  START_VOLUME_FLOOR_M,
} from "../constants";
import { reEntryFactor } from "./re-entry";
import { maxWeeklyVolumeM } from "./weekly-volume";

export interface StartVolumeInput {
  baseline: PlanBaseline;
  distanceKey: RaceDistanceKey;
  daysPerWeek: number;
  /** The smallest week that holds week 1's sessions on this many days a week, in whole meters. */
  neededWeeklyM: (daysPerWeek: number) => number;
}

export type StartVolumeResult =
  | { ok: true; startVolumeM: number; warning: PlanWarning | null }
  | { ok: false; conflict: PlanConflict };

/** Mean of the baseline weeks with running: a week off is not a week of zero training, 0 with none. */
export function recentVolumeM(weeklyVolumesM: readonly number[]): number {
  const running = weeklyVolumesM.filter((m) => m > 0);
  return running.length === 0 ? 0 : running.reduce((sum, m) => sum + m, 0) / running.length;
}

/** The baseline weeks after the last one with running: the weeks off right before the plan. */
export function trailingEmptyWeeks(weeklyVolumesM: readonly number[]): number {
  return weeklyVolumesM.length - 1 - weeklyVolumesM.findLastIndex((m) => m > 0);
}

/**
 * The share of recent volume a runner restarts at: the smaller of the factors for the days since the
 * last run and for the empty weeks right before the plan, each 7 days off. A run yesterday after three
 * empty weeks is one run, not a return to the volume of a month ago.
 */
export function baselineReEntryFactor(baseline: PlanBaseline): number {
  return Math.min(
    reEntryFactor(baseline.daysSinceLastRun),
    reEntryFactor(RE_ENTRY_DAYS_PER_EMPTY_WEEK * trailingEmptyWeeks(baseline.weeklyVolumesM)),
  );
}

/** The recent weekly volume the runner returns to, after re-entry, in whole meters; 0 with none. */
export function reEnteredVolumeM(baseline: PlanBaseline): number {
  return Math.floor(recentVolumeM(baseline.weeklyVolumesM) * baselineReEntryFactor(baseline));
}

/**
 * Week 1's volume. A runner with history starts at their recent volume after re-entry, lifted to the
 * smallest week the days asked for need when the 10% rule allows the lift. When it does not, and fewer
 * days would fit, the goal is a too_many_days conflict with the most days that fit; when not even the
 * fewest days the distance allows fit, no choice of days keeps to 10%, so week 1 is lifted anyway with
 * start_volume_lifted. A runner with no recent running starts at the needed week, never under the
 * distance's floor, with no_recent_runs.
 */
export function startVolume({
  baseline,
  distanceKey,
  daysPerWeek,
  neededWeeklyM,
}: StartVolumeInput): StartVolumeResult {
  const neededM = neededWeeklyM(daysPerWeek);
  const recentM = reEnteredVolumeM(baseline);
  if (recentM === 0) {
    const startVolumeM = Math.max(neededM, START_VOLUME_FLOOR_M[distanceKey]);
    return { ok: true, startVolumeM, warning: { code: "no_recent_runs", startVolumeM } };
  }
  if (recentM >= neededM) return { ok: true, startVolumeM: recentM, warning: null };
  const allowedM = maxWeeklyVolumeM(recentM);
  if (neededM <= allowedM) return { ok: true, startVolumeM: neededM, warning: null };
  for (let days = daysPerWeek - 1; days >= MIN_DAYS_PER_WEEK[distanceKey]; days -= 1) {
    if (neededWeeklyM(days) <= allowedM) {
      return {
        ok: false,
        conflict: {
          code: "too_many_days",
          daysPerWeek,
          maxDaysPerWeek: days,
          recentWeeklyM: recentM,
          neededWeeklyM: neededM,
        },
      };
    }
  }
  return {
    ok: true,
    startVolumeM: neededM,
    warning: { code: "start_volume_lifted", recentWeeklyM: recentM, startVolumeM: neededM },
  };
}
