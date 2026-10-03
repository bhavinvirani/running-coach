import {
  distanceInUnits,
  type PaceZone,
  type PlanPaces,
  type Repeat,
  type SessionSteps,
  type Step,
  type Units,
} from "@running-coach/shared";
import {
  MISSING,
  formatCountValue,
  formatMeters,
  formatStepDistance,
  formatStepDuration,
} from "./format";
import { formatPlanPace } from "./pace-band";

/** A lone run's zone after its band: "5:45-6:20 /km easy", "4:56 /km race pace". */
const LONE_RUN_ZONES: Readonly<Record<PaceZone, string>> = {
  easy: "easy",
  marathon: "marathon pace",
  threshold: "threshold",
  interval: "interval pace",
  repetition: "repetition pace",
  race: "race pace",
};

/**
 * A session's steps as one line a runner reads before heading out, with paces from the plan's bands in
 * the runner's unit: "15 min easy, 5 x 1 km at 4:45-4:52 /km with 3 min jog, 10 min easy". Inside such a
 * session easy running names no pace (it is run by feel), a recovery is a jog, and every other zone reads
 * "at" its band. A session of one run step (an easy run, the long run, the race) reads its band and zone
 * instead, "5:45-6:20 /km easy": its amount is already the row's distance and time, and the runner wants
 * the pace to hold. Empty for a session with no steps.
 */
export function describeSteps(steps: SessionSteps, paces: PlanPaces, units: Units): string {
  const [only] = steps;
  if (steps.length === 1 && only !== undefined && !("repeat" in only) && only.kind === "run") {
    return `${formatPlanPace(paces[only.zone], units)} ${LONE_RUN_ZONES[only.zone]}`;
  }
  return steps
    .map((item) =>
      "repeat" in item ? describeRepeat(item, paces, units) : describeStep(item, paces, units),
    )
    .join(", ");
}

/**
 * "5 x 1 km at 4:45-4:52 /km with 3 min jog"; a repeat of several hard steps groups them, "3 x (1 km at
 * …, 400 m at …) with 2 min jog".
 */
function describeRepeat({ repeat, steps }: Repeat, paces: PlanPaces, units: Units): string {
  const work = steps.filter((step) => step.kind !== "recovery");
  const recoveries = steps.filter((step) => step.kind === "recovery");
  if (work.length === 0) {
    return `${formatCountValue(repeat)} x ${recoveries.map((step) => describeStep(step, paces, units)).join(", ")}`;
  }
  const described = work.map((step) => describeStep(step, paces, units));
  const main = described.length === 1 ? described.join("") : `(${described.join(", ")})`;
  const recovery =
    recoveries.length === 0
      ? ""
      : ` with ${recoveries.map((step) => describeStep(step, paces, units)).join(" and ")}`;
  return `${formatCountValue(repeat)} x ${main}${recovery}`;
}

function describeStep(step: Step, paces: PlanPaces, units: Units): string {
  const amount = stepAmount(step, units);
  if (step.kind === "recovery") return `${amount} jog`;
  if (step.zone === "easy") return `${amount} easy`;
  return `${amount} at ${formatPlanPace(paces[step.zone], units)}`;
}

function stepAmount(step: Step, units: Units): string {
  if (step.distanceM !== null) return stepDistance(step.distanceM, units);
  return step.durationS !== null ? formatStepDuration(step.durationS) : MISSING;
}

/** Under one unit a rep reads in meters, as on a track whatever the unit: "400 m", not "0.25 mi". */
function stepDistance(distanceM: number, units: Units): string {
  const inUnits = distanceInUnits(distanceM, units);
  return inUnits < 1 ? formatMeters(distanceM) : formatStepDistance(inUnits, units);
}
