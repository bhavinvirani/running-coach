import type { PlanConflict, PlanWarning, RaceDistanceKey } from "@running-coach/shared";
import {
  LONG_RUN_FLOOR_M,
  LONG_RUN_MAX_S,
  LONG_RUN_SHARE,
  LONG_RUN_SHARE_3_DAYS,
  LONGEST_RUN_LOOKBACK_WEEKS,
  LONGEST_RUN_MAX_INCREASE,
  MIN_DAYS_PER_WEEK,
  REQUIRED_LONG_RUN_MIN,
} from "../constants";
import { distanceForDurationM } from "./session-target";

export interface LongRunInput {
  weekVolumeM: number;
  daysPerWeek: number;
  /** The easy band's midpoint, the pace the long run is planned at. */
  easyPaceSPerKm: number;
  /** 110% of the longest run of the last 4 weeks. */
  maxRunM: number;
}

export interface LongRunFloorInput extends LongRunInput {
  /** The baseline's longest run of the last 30 days; 0 with none. */
  baselineLongestM: number;
  /** 20 min at the easy midpoint: what each of the week's other runs needs at least. */
  minRunM: number;
}

export interface LongestInWindowInput {
  /** The longest run of each plan week built so far, week 1 first. */
  longestByWeekM: readonly number[];
  /** The baseline's longest run, standing for the 4 weeks before the plan. */
  seedM: number;
}

export function longRunShare(daysPerWeek: number): number {
  return daysPerWeek === 3 ? LONG_RUN_SHARE_3_DAYS : LONG_RUN_SHARE;
}

/** The week's long run: the smallest of its share of the week, 150 min easy and 110% of the recent longest. */
export function longRunM({
  weekVolumeM,
  daysPerWeek,
  easyPaceSPerKm,
  maxRunM,
}: LongRunInput): number {
  return Math.floor(
    Math.min(
      longRunShare(daysPerWeek) * weekVolumeM,
      distanceForDurationM(LONG_RUN_MAX_S, easyPaceSPerKm),
      maxRunM,
    ),
  );
}

/**
 * What a base, build or peak week's long run never drops under: the runner's own longest recent run,
 * as far as 150 min easy, 110% of the recent longest and the week less 20 min on every other day
 * allow; 0 with no runs. The share cap keeps the long run from growing past its share of the week; it
 * does not shrink what the runner already runs, which would be a regression no runner would accept.
 * Taper and race weeks do not use it: there the share cap is the point.
 */
export function longRunFloorM({
  baselineLongestM,
  weekVolumeM,
  daysPerWeek,
  easyPaceSPerKm,
  maxRunM,
  minRunM,
}: LongRunFloorInput): number {
  return Math.max(
    0,
    Math.min(
      baselineLongestM,
      distanceForDurationM(LONG_RUN_MAX_S, easyPaceSPerKm),
      maxRunM,
      weekVolumeM - (daysPerWeek - 1) * minRunM,
    ),
  );
}

/** No run over 110% of the longest recent run, in whole meters. */
export function maxRunM(longestRecentM: number): number {
  if (!Number.isFinite(longestRecentM) || longestRecentM <= 0) {
    throw new RangeError(`longestRecentM must be finite and > 0, got ${longestRecentM}`);
  }
  return Math.floor(longestRecentM * (1 + LONGEST_RUN_MAX_INCREASE));
}

/**
 * The longest run to grow from. A runner with no recent run, or only a short one, starts from the 5 km
 * floor: 110% of a 2 km jog would leave no room for a 20 min run or a quality session.
 */
export function longestRunSeedM(baselineLongestM: number): number {
  return Math.max(baselineLongestM, LONG_RUN_FLOOR_M);
}

/** The longest run of the last 4 weeks, the baseline standing in for the weeks before the plan. */
export function longestInWindowM({ longestByWeekM, seedM }: LongestInWindowInput): number {
  const window = longestByWeekM.slice(-LONGEST_RUN_LOOKBACK_WEEKS);
  return Math.max(...window, window.length < LONGEST_RUN_LOOKBACK_WEEKS ? seedM : 0);
}

/** Too few runs a week for the long run a distance needs to stay inside its share of the week. */
export function longRunDaysConflict({
  distanceKey,
  daysPerWeek,
}: {
  distanceKey: RaceDistanceKey;
  daysPerWeek: number;
}): PlanConflict | null {
  const minDaysPerWeek = MIN_DAYS_PER_WEEK[distanceKey];
  return daysPerWeek < minDaysPerWeek
    ? { code: "long_run_cap", distanceKey, daysPerWeek, minDaysPerWeek }
    : null;
}

/** The peak long run the distance usually asks for, as meters at the easy midpoint pace. */
export function requiredLongRunM({
  distanceKey,
  easyPaceSPerKm,
}: {
  distanceKey: RaceDistanceKey;
  easyPaceSPerKm: number;
}): number {
  return distanceForDurationM(REQUIRED_LONG_RUN_MIN[distanceKey] * 60, easyPaceSPerKm);
}

/** A warning, never a conflict: the caps decide the long run, and the runner should know it is short. */
export function longRunWarning({
  peakLongRunM,
  requiredLongRunM: required,
}: {
  peakLongRunM: number;
  requiredLongRunM: number;
}): PlanWarning | null {
  return peakLongRunM < required
    ? { code: "long_run_short", peakLongRunM, requiredLongRunM: required }
    : null;
}
