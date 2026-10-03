import {
  distanceInUnits,
  type PaceZone,
  type PlanPaces,
  type PlanSession,
  type Step,
  type StepKind,
  type Units,
} from "@running-coach/shared";
import { MISSING, formatMeters, formatStepDistance, formatStepDuration } from "./format";
import { formatPlanPace } from "./pace-band";
import { sessionTypeName } from "./session-type";

const STEP_KIND_NAMES: Readonly<Record<StepKind, string>> = {
  warmup: "Warm-up",
  run: "Run",
  work: "Work",
  recovery: "Recovery",
  cooldown: "Cool-down",
};

/** A step's kind as the watch and the builder name it: "Warm-up", "Cool-down". */
export function stepKindName(kind: StepKind): string {
  return STEP_KIND_NAMES[kind];
}

const PACE_ZONE_NAMES: Readonly<Record<PaceZone, string>> = {
  easy: "Easy",
  marathon: "Marathon",
  threshold: "Threshold",
  interval: "Interval",
  repetition: "Repetition",
  race: "Race",
};

/** A zone on its own, as a label: the plan's pace tiles and the builder's zone picker. */
export function paceZoneName(zone: PaceZone): string {
  return PACE_ZONE_NAMES[zone];
}

const ZONE_PHRASES: Readonly<Record<PaceZone, string>> = {
  easy: "easy",
  marathon: "marathon pace",
  threshold: "threshold",
  interval: "interval pace",
  repetition: "repetition pace",
  race: "race pace",
};

/** A zone after its band in a line: "5:45-6:20 /km easy", "4:56 /km race pace". */
export function zonePhrase(zone: PaceZone): string {
  return ZONE_PHRASES[zone];
}

/**
 * Run and work steps go to the watch with their zone's pace band; warm-up, recovery and cool-down go out
 * open (the engine's garminWorkout), so the watch never alerts while the runner jogs.
 */
export function isPacedStep(kind: StepKind): boolean {
  return kind === "run" || kind === "work";
}

/** What an open step says instead of a band. */
export const OPEN_STEP_TARGET = "Easy, no pace alert";

/**
 * A step's target as the watch holds it, in the runner's unit: "4:45-4:52 /km interval pace" for run and
 * work steps, "Easy, no pace alert" for the others.
 */
export function stepTarget(step: Pick<Step, "kind" | "zone">, paces: PlanPaces, units: Units) {
  if (!isPacedStep(step.kind)) return OPEN_STEP_TARGET;
  return `${formatPlanPace(paces[step.zone], units)} ${zonePhrase(step.zone)}`;
}

/** A step's length: "15 min", "1 km", "400 m". Under one unit a rep reads in meters, as on a track. */
export function stepAmount(step: Pick<Step, "distanceM" | "durationS">, units: Units): string {
  if (step.distanceM !== null) {
    const inUnits = distanceInUnits(step.distanceM, units);
    return inUnits < 1 ? formatMeters(step.distanceM) : formatStepDistance(inUnits, units);
  }
  return step.durationS !== null ? formatStepDuration(step.durationS) : MISSING;
}

/** A session's name: the runner's title for a custom workout that has one, else its type. */
export function sessionName(session: Pick<PlanSession, "title" | "type">): string {
  return session.title ?? sessionTypeName(session.type);
}
