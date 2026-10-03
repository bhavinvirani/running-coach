import type {
  PaceBand,
  PaceZone,
  PlanPaces,
  SessionSteps,
  SessionTarget,
  Step,
} from "@running-coach/shared";

const METERS_PER_KM = 1000;

/** A step with how many times it runs: 1, or its repeat's count. */
interface Counted {
  step: Step;
  times: number;
}

/** The pace a session is planned at inside a band. Unrounded, so a band's time and distance agree. */
export function bandMidpointSPerKm(band: PaceBand): number {
  return (band.fastSPerKm + band.slowSPerKm) / 2;
}

/** Whole meters covered in `durationS` at a pace, rounded down so a time cap holds. */
export function distanceForDurationM(durationS: number, paceSPerKm: number): number {
  return Math.floor((durationS * METERS_PER_KM) / paceSPerKm);
}

export function flattenSteps(steps: SessionSteps): Counted[] {
  return steps.flatMap((item) =>
    "repeat" in item
      ? item.steps.map((step) => ({ step, times: item.repeat }))
      : [{ step: item, times: 1 }],
  );
}

// The step schema sets exactly one of distanceM and durationS, so the other is never null here.

/** A step's meters: its own, or its time at its zone's midpoint pace. */
export function stepDistanceM(step: Step, paces: PlanPaces): number {
  return (
    step.distanceM ??
    Math.round((step.durationS! * METERS_PER_KM) / bandMidpointSPerKm(paces[step.zone]))
  );
}

/** A step's seconds: its own, or its distance at its zone's midpoint pace. */
export function stepDurationS(step: Step, paces: PlanPaces): number {
  return (
    step.durationS ??
    Math.round((step.distanceM! * bandMidpointSPerKm(paces[step.zone])) / METERS_PER_KM)
  );
}

/** Total distance and time over every step, repeats included; the zone is the work's, else the run's. */
export function sessionTarget(steps: SessionSteps, paces: PlanPaces): SessionTarget {
  const counted = flattenSteps(steps);
  const zoneOf = (kind: Step["kind"]): PaceZone | undefined =>
    counted.find(({ step }) => step.kind === kind)?.step.zone;
  return {
    distanceM: counted.reduce(
      (sum, { step, times }) => sum + times * stepDistanceM(step, paces),
      0,
    ),
    durationS: counted.reduce(
      (sum, { step, times }) => sum + times * stepDurationS(step, paces),
      0,
    ),
    zone: zoneOf("work") ?? zoneOf("run") ?? "easy",
  };
}
