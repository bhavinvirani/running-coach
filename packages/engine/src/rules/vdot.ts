import type { PaceBand, PlanPaces } from "@running-coach/shared";
import { VO2_COST, VO2MAX_SHARE, ZONE_VDOT_SHARES } from "../constants";

export interface Performance {
  distanceM: number;
  timeS: number;
}

/** The five Daniels zones; the plan adds the race zone from the prediction rule. */
export type TrainingPaces = Omit<PlanPaces, "race">;

const METERS_PER_KM = 1000;
const SECONDS_PER_MIN = 60;

/**
 * Daniels and Gilbert's VDOT: the VO2 cost of the performance's speed over the share of VO2max a runner
 * holds for its duration. Unrounded, so the API can compare several performances.
 */
export function vdotFromPerformance({ distanceM, timeS }: Performance): number {
  if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(timeS) || timeS <= 0) {
    throw new RangeError(
      `A performance needs a positive distance and time, got ${distanceM} m in ${timeS} s`,
    );
  }
  const minutes = timeS / SECONDS_PER_MIN;
  const v = distanceM / minutes;
  const vo2 = VO2_COST.intercept + VO2_COST.linear * v + VO2_COST.quadratic * v * v;
  const share =
    VO2MAX_SHARE.base +
    VO2MAX_SHARE.a * Math.exp(-VO2MAX_SHARE.ka * minutes) +
    VO2MAX_SHARE.b * Math.exp(-VO2MAX_SHARE.kb * minutes);
  const vdot = vo2 / share;
  if (vdot <= 0) {
    throw new RangeError(`${distanceM} m in ${timeS} s is too slow to give a VDOT`);
  }
  return vdot;
}

/** One decimal: what the plan stores and every pace is computed from, so paces can be recomputed from it. */
export function roundVdot(vdot: number): number {
  return Math.round(vdot * 10) / 10;
}

/** Seconds per km at `share` of VDOT: the positive root of the VO2 cost equation, as a pace. */
export function paceAtShareSPerKm(vdot: number, share: number): number {
  if (!Number.isFinite(vdot) || vdot <= 0) {
    throw new RangeError(`vdot must be finite and > 0, got ${vdot}`);
  }
  const { intercept, linear, quadratic } = VO2_COST;
  const c = intercept - share * vdot;
  const v = (-linear + Math.sqrt(linear * linear - 4 * quadratic * c)) / (2 * quadratic);
  return (METERS_PER_KM * SECONDS_PER_MIN) / v;
}

function band(vdot: number, [slowShare, fastShare]: readonly [number, number]): PaceBand {
  return {
    fastSPerKm: Math.round(paceAtShareSPerKm(vdot, fastShare)),
    slowSPerKm: Math.round(paceAtShareSPerKm(vdot, slowShare)),
  };
}

export function pacesFromVdot(vdot: number): TrainingPaces {
  return {
    easy: band(vdot, ZONE_VDOT_SHARES.easy),
    marathon: band(vdot, ZONE_VDOT_SHARES.marathon),
    threshold: band(vdot, ZONE_VDOT_SHARES.threshold),
    interval: band(vdot, ZONE_VDOT_SHARES.interval),
    repetition: band(vdot, ZONE_VDOT_SHARES.repetition),
  };
}
