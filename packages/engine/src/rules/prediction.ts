import { DISTANCE_METERS, type PaceBand, type PlanWarning } from "@running-coach/shared";
import {
  MARATHON_PREDICTION_MARGIN,
  RACE_PACE_BAND,
  RIEGEL_EXPONENT,
  TARGET_TIME_AMBITIOUS_MARGIN,
} from "../constants";

export interface PredictionInput {
  fromDistanceM: number;
  fromTimeS: number;
  toDistanceM: number;
}

export interface RacePaceInput {
  /** The race distance, unrounded (a half is 21097.5 m). */
  distanceM: number;
  predictedTimeS: number;
  targetTimeS: number | null;
  /** The easy band's slow end: a target slower than it is no target. */
  easySlowSPerKm: number;
}

export interface RacePaceResult {
  band: PaceBand;
  warning: PlanWarning | null;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and > 0, got ${value}`);
  }
}

/** Riegel's prediction in whole seconds, plus the marathon margin when a shorter race predicts the marathon. */
export function predictTimeS({ fromDistanceM, fromTimeS, toDistanceM }: PredictionInput): number {
  assertPositive("fromDistanceM", fromDistanceM);
  assertPositive("fromTimeS", fromTimeS);
  assertPositive("toDistanceM", toDistanceM);
  const riegelS = fromTimeS * (toDistanceM / fromDistanceM) ** RIEGEL_EXPONENT;
  const marathonFromShorter =
    toDistanceM === DISTANCE_METERS.marathon && fromDistanceM < toDistanceM;
  return Math.round(riegelS * (marathonFromShorter ? 1 + MARATHON_PREDICTION_MARGIN : 1));
}

/**
 * The race zone: the target's pace when it is within 5% of the prediction or slower, else the
 * prediction's pace and a warning. A target slower than the easy band's slow end is no target: race
 * pace would be easy running, and race-pace work would count as hard time a week could never hold.
 * The band is that pace +-1.5%.
 */
export function racePace({
  distanceM,
  predictedTimeS,
  targetTimeS,
  easySlowSPerKm,
}: RacePaceInput): RacePaceResult {
  assertPositive("distanceM", distanceM);
  assertPositive("predictedTimeS", predictedTimeS);
  const ambitious =
    targetTimeS !== null &&
    predictedTimeS - targetTimeS > TARGET_TIME_AMBITIOUS_MARGIN * predictedTimeS;
  const slowerThanEasy = targetTimeS !== null && (targetTimeS * 1000) / distanceM > easySlowSPerKm;
  const raceTimeS =
    targetTimeS === null || ambitious || slowerThanEasy ? predictedTimeS : targetTimeS;
  const paceSPerKm = (raceTimeS * 1000) / distanceM;
  return {
    band: {
      fastSPerKm: Math.round(paceSPerKm * (1 - RACE_PACE_BAND)),
      slowSPerKm: Math.round(paceSPerKm * (1 + RACE_PACE_BAND)),
    },
    warning: ambitious ? { code: "target_time_ambitious", targetTimeS, predictedTimeS } : null,
  };
}
