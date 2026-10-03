import {
  GARMIN_WORKOUT_NAME_MAX,
  type GarminStepType,
  type GarminWorkout,
  type GarminWorkoutStep,
  type PlanPaces,
  type SessionSteps,
  type Step,
  type StepKind,
} from "@running-coach/shared";
import { TARGETED_STEP_KINDS } from "../constants";
import { sessionTarget } from "./session-target";

export interface GarminWorkoutInput {
  /** The title on the watch, within GARMIN_WORKOUT_NAME_MAX; the API builds it in the runner's units. */
  name: string;
  steps: SessionSteps;
  paces: PlanPaces;
}

// A "Run" step on the watch is Garmin's "interval"; a work step is a run at a harder zone.
const GARMIN_STEP_TYPES: Readonly<Record<StepKind, GarminStepType>> = {
  warmup: "warmup",
  run: "interval",
  work: "interval",
  recovery: "recovery",
  cooldown: "cooldown",
};

function garminStep(step: Step, paces: PlanPaces): GarminWorkoutStep {
  const band = paces[step.zone];
  return {
    type: GARMIN_STEP_TYPES[step.kind],
    distanceM: step.distanceM,
    durationS: step.durationS,
    pace: TARGETED_STEP_KINDS.has(step.kind)
      ? { fastSPerKm: band.fastSPerKm, slowSPerKm: band.slowSPerKm }
      : null,
  };
}

/**
 * A session as the watch runs it: the same steps and repeats, each ending on its own distance or time;
 * run and work steps target their zone's band and the rest go open. The API pushes only sessions with
 * steps and names them within the cap, so anything else is a programmer error.
 */
export function garminWorkout({ name, steps, paces }: GarminWorkoutInput): GarminWorkout {
  if (steps.length === 0) {
    throw new RangeError("A Garmin workout needs at least one step");
  }
  if (name.length === 0 || name.length > GARMIN_WORKOUT_NAME_MAX) {
    throw new RangeError(
      `A Garmin workout name is 1 to ${GARMIN_WORKOUT_NAME_MAX} characters, got ${name.length}`,
    );
  }
  return {
    name,
    estimatedDurationS: sessionTarget(steps, paces).durationS,
    steps: steps.map((item) =>
      "repeat" in item
        ? { repeat: item.repeat, steps: item.steps.map((step) => garminStep(step, paces)) }
        : garminStep(item, paces),
    ),
  };
}
