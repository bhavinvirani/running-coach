import type { PlanPhase, SessionSteps } from "@running-coach/shared";
import { FAST_FINISH, FLOAT_TOLERANCE } from "../constants";

export interface FastFinishWeek {
  phase: PlanPhase;
  /** A down week (volume-curve.ts isDownWeek). */
  down: boolean;
}

export interface LongRunStepsInput {
  /** The long run's distance as the week gave it, the finish included. */
  distanceM: number;
  /** Its last meters at marathon pace; 0 for none. */
  finishM: number;
}

const FINISH_PHASES: ReadonlySet<PlanPhase> = new Set(["build", "peak"]);

/**
 * Which weeks end their long run at marathon pace: every second build or peak week that is not a down
 * week, counted from the first of them, which gets one. Never a base, down, taper or race week.
 */
export function fastFinishWeeks(weeks: readonly FastFinishWeek[]): boolean[] {
  let counted = 0;
  return weeks.map(({ phase, down }) => {
    if (down || !FINISH_PHASES.has(phase)) return false;
    counted += 1;
    return counted % 2 === 1;
  });
}

/** The long run's last 20% at marathon pace, down to whole 500 m, at most 5 km; 0 under 1 km. */
export function fastFinishM(longM: number): number {
  const { share, minM, maxM, stepM } = FAST_FINISH;
  // The nudge keeps a finish that lands on a whole step on it (0.2 x 7500 m is exactly 3 steps).
  const finishM = Math.min(Math.floor((share * longM) / stepM + FLOAT_TOLERANCE) * stepM, maxM);
  return finishM >= minM ? finishM : 0;
}

/** A finish 500 m shorter, the easy-time rule's first cut; 0 once it would be under 1 km. */
export function shorterFinishM(finishM: number): number {
  const shorterM = finishM - FAST_FINISH.stepM;
  return shorterM >= FAST_FINISH.minM ? shorterM : 0;
}

/**
 * The long run's steps: easy, then its finish at marathon pace carved out of the same distance, so the
 * week keeps its meters. The finish is a run step, not work: the session stays a long run, and the 80%
 * rule counts the finish as hard time (easy-share.ts).
 */
export function longRunSteps({ distanceM, finishM }: LongRunStepsInput): SessionSteps {
  if (finishM === 0) return [{ kind: "run", zone: "easy", distanceM, durationS: null }];
  return [
    { kind: "run", zone: "easy", distanceM: distanceM - finishM, durationS: null },
    { kind: "run", zone: "marathon", distanceM: finishM, durationS: null },
  ];
}
