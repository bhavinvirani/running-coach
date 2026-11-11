import type { PlanPaces, Repeat, SessionSteps, Step } from "@running-coach/shared";
import {
  EASY_RUN_STRIDES,
  MIN_RUN_S,
  STRIDE_RECOVERY_S,
  STRIDE_RUN_S,
  STRIDES_MAX_QUALITY,
} from "../constants";
import { stepDistanceM, stepDurationS } from "./session-target";

export interface WithStridesInput {
  /** The run's distance as the plan gave it, strides included. */
  distanceM: number;
  count: number;
  paces: PlanPaces;
}

export interface StridesRunInput {
  /** The week's easy runs: weekday (0 for Monday) and meters, in any order. */
  runs: readonly { day: number; distanceM: number }[];
  /** The weekday after the long run's. */
  afterLongDay: number;
  /** The quality sessions the week holds. */
  qualityCount: number;
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

/**
 * Which easy run carries the week's 6 strides: in a week of at most 1 quality session, the latest run
 * that is not the day after the long run and keeps 20 min easy before them; null for none. One run a
 * week at most, so a week never holds strides twice.
 */
export function stridesRunIndex({
  runs,
  afterLongDay,
  qualityCount,
  paces,
}: StridesRunInput): number | null {
  if (qualityCount > STRIDES_MAX_QUALITY) return null;
  const eligible = [...runs.keys()].filter(
    (k) =>
      runs[k]!.day !== afterLongDay &&
      withStrides({ distanceM: runs[k]!.distanceM, count: EASY_RUN_STRIDES, paces }).length > 1,
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((latest, k) => (runs[k]!.day > runs[latest]!.day ? k : latest));
}
