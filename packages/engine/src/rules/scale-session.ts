import {
  STEP_MAX_DISTANCE_M,
  STEP_MAX_DURATION_S,
  type PlanPaces,
  type SessionSteps,
  type Step,
} from "@running-coach/shared";
import {
  FLOAT_TOLERANCE,
  MIN_RUN_S,
  SCALE_DISTANCE_STEP_M,
  SCALE_DURATION_STEP_S,
} from "../constants";
import { bandMidpointSPerKm, flattenSteps } from "./session-target";
import { minRunDistanceM } from "./week-fill";

export interface ScaleStepsInput {
  steps: SessionSteps;
  /** The share of the planned session, already clamped by the caller; > 0. */
  factor: number;
  paces: PlanPaces;
}

export interface ScaleSessionResult {
  steps: SessionSteps;
  /** A cut stopped at the 20 min minimum run, or at a run already shorter than that. */
  atMinimum: boolean;
}

/** Down to a whole step; the tolerance keeps a product a hair under a step on that step. */
function floorTo(value: number, step: number): number {
  return Math.floor(value / step + FLOAT_TOLERANCE) * step;
}

function isQuality(steps: SessionSteps): boolean {
  return flattenSteps(steps).some(({ step }) => step.kind === "work");
}

/** A work step cut to whole 100 m or 10 s, never to nothing: one step, or itself when shorter. */
function cutWork(step: Step, factor: number): Step {
  return step.distanceM === null
    ? {
        ...step,
        durationS: Math.max(
          floorTo(step.durationS! * factor, SCALE_DURATION_STEP_S),
          Math.min(step.durationS!, SCALE_DURATION_STEP_S),
        ),
      }
    : {
        ...step,
        distanceM: Math.max(
          floorTo(step.distanceM * factor, SCALE_DISTANCE_STEP_M),
          Math.min(step.distanceM, SCALE_DISTANCE_STEP_M),
        ),
      };
}

/**
 * Fewer reps or shorter work; warm-up, cool-down, recoveries and runs stay. A repeat cut to one rep
 * unwraps into its steps, since a repeat holds at least 2. When the factor leaves the rep count as it
 * is (2 x 1500 m at 0.8 still rounds to 2), each rep's work shrinks instead, so a cut always cuts.
 * Quality never grows here: a factor of 1 or more leaves it as planned.
 */
function scaleQuality(steps: SessionSteps, factor: number): SessionSteps {
  if (factor >= 1) return steps;
  return steps.flatMap((item): SessionSteps => {
    if ("repeat" in item) {
      if (!item.steps.some((step) => step.kind === "work")) return [item];
      const repeat = Math.max(1, Math.round(item.repeat * factor));
      if (repeat === item.repeat) {
        const cut = item.steps.map((step) => (step.kind === "work" ? cutWork(step, factor) : step));
        return [{ ...item, steps: cut }];
      }
      return repeat === 1 ? item.steps : [{ ...item, repeat }];
    }
    return item.kind === "work" ? [cutWork(item, factor)] : [item];
  });
}

/**
 * Each run step outside a repeat by the factor, floored to whole 100 m or 10 s. A cut never takes a
 * run under 20 min (3750 m at a 320 s/km easy midpoint), nor under itself when already shorter; a rise
 * never ends under the planned run or past the longest step the contract allows. Repeats stay, so a
 * walk-run keeps its rounds.
 */
function scaleRuns(steps: SessionSteps, factor: number, paces: PlanPaces): ScaleSessionResult {
  const minRunM = minRunDistanceM(bandMidpointSPerKm(paces.easy));
  let atMinimum = false;
  const scale = (value: number, step: number, minimum: number, maximum: number): number => {
    const scaled = floorTo(value * factor, step);
    if (factor > 1) return Math.max(value, Math.min(scaled, maximum));
    const floor = Math.min(value, minimum);
    atMinimum ||= floor > scaled;
    return Math.max(scaled, floor);
  };
  const scaled = steps.map((item) => {
    if ("repeat" in item || item.kind !== "run") return item;
    return item.distanceM === null
      ? {
          ...item,
          durationS: scale(item.durationS!, SCALE_DURATION_STEP_S, MIN_RUN_S, STEP_MAX_DURATION_S),
        }
      : {
          ...item,
          distanceM: scale(item.distanceM, SCALE_DISTANCE_STEP_M, minRunM, STEP_MAX_DISTANCE_M),
        };
  });
  return { steps: scaled, atMinimum };
}

/**
 * A session's steps at a share of their size: a quality session (any work step) loses reps or work, an
 * easy or long run shrinks or grows. Deterministic, and every result still parses with the contract's
 * steps schema. A factor that is not finite and positive is a programmer error: callers clamp first.
 */
export function scaleSession({ steps, factor, paces }: ScaleStepsInput): ScaleSessionResult {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError(`factor must be finite and > 0, got ${factor}`);
  }
  if (factor === 1) return { steps, atMinimum: false };
  return isQuality(steps)
    ? { steps: scaleQuality(steps, factor), atMinimum: false }
    : scaleRuns(steps, factor, paces);
}

/** The steps of scaleSession alone. */
export function scaleSteps(input: ScaleStepsInput): SessionSteps {
  return scaleSession(input).steps;
}
