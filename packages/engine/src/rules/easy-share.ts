import type { PaceZone, PlanPaces, SessionSteps } from "@running-coach/shared";
import { HARD_TIME_MAX_SHARE } from "../constants";
import { flattenSteps, stepDurationS } from "./session-target";

// Daniels' quality intensities plus race pace; warmups, recoveries, easy and long runs are easy time.
const HARD_ZONES: ReadonlySet<PaceZone> = new Set(["threshold", "interval", "repetition", "race"]);

/** Seconds of work in a hard zone; the race's own run step is not training load the week plans around. */
export function hardTimeS(steps: SessionSteps, paces: PlanPaces): number {
  return flattenSteps(steps)
    .filter(({ step }) => step.kind === "work" && HARD_ZONES.has(step.zone))
    .reduce((sum, { step, times }) => sum + times * stepDurationS(step, paces), 0);
}

/** At least 80% of the week's time is easy. */
export function hardShareHolds({ hardS, totalS }: { hardS: number; totalS: number }): boolean {
  return hardS <= Math.floor(totalS * HARD_TIME_MAX_SHARE);
}
