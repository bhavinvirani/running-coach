import type { PlanPaces, Repeat, SessionSteps, Step } from "@running-coach/shared";
import { MIN_RUN_S, STRIDE_RECOVERY_S, STRIDE_RUN_S } from "../constants";
import { stepDistanceM, stepDurationS } from "./session-target";

export interface WithStridesInput {
  /** The run's distance as the plan gave it, strides included. */
  distanceM: number;
  count: number;
  paces: PlanPaces;
}

/**
 * `count` strides: a 20 s quick run in the repetition zone, then a 60 s easy jog. Run steps, not work:
 * the session stays an easy run, though the 80% rule counts their quick time as hard (easy-share.ts).
 */
export function stridesRepeat(count: number): Repeat {
  if (!Number.isInteger(count) || count < 2) {
    throw new RangeError(`Strides repeat at least 2 times, got ${count}`);
  }
  return {
    repeat: count,
    steps: [
      { kind: "run", zone: "repetition", distanceM: null, durationS: STRIDE_RUN_S },
      { kind: "recovery", zone: "easy", distanceM: null, durationS: STRIDE_RECOVERY_S },
    ],
  };
}

/** The meters `count` strides take at their zones' midpoint paces. */
export function stridesM(count: number, paces: PlanPaces): number {
  const { repeat, steps } = stridesRepeat(count);
  return repeat * steps.reduce((sum, step) => sum + stepDistanceM(step, paces), 0);
}

/**
 * An easy run of `distanceM` that ends with `count` strides carved out of it, so the session keeps the
 * distance the plan gave it. The run before them keeps at least 20 min at the easy midpoint; when it
 * would not, the session is the plain run.
 */
export function withStrides({ distanceM, count, paces }: WithStridesInput): SessionSteps {
  const plain: Step = { kind: "run", zone: "easy", distanceM, durationS: null };
  const runM = distanceM - stridesM(count, paces);
  const run: Step = { ...plain, distanceM: runM };
  return stepDurationS(run, paces) >= MIN_RUN_S ? [run, stridesRepeat(count)] : [plain];
}
