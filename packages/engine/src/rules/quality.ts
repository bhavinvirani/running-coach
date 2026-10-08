import type {
  PaceZone,
  PlanPaces,
  PlanPhase,
  RaceDistanceKey,
  SessionSteps,
  SessionType,
  Step,
} from "@running-coach/shared";
import {
  COOLDOWN_S,
  INTERVAL_RECOVERY_S,
  INTERVAL_REP_M,
  MIN_REPS_FOR_LONGER,
  ONE_QUALITY_ROTATION,
  RACE_PRACTICE_RECOVERY_S,
  RACE_PRACTICE_REP_M,
  REPETITION_RECOVERY_S,
  REPETITION_REP_M,
  RACE_WEEK_DAYS,
  TAPER_TEMPO_MIN_DAYS,
  THRESHOLD_BLOCK_MIN_M,
  THRESHOLD_BLOCK_ROTATION,
  THRESHOLD_BLOCK_STEP_M,
  THRESHOLD_RECOVERY_S,
  THRESHOLD_SINGLE_MAX_S,
  WARMUP_S,
  WORK_CAP_SHARE,
} from "../constants";
import { stepDistanceM, stepDurationS } from "./session-target";

/** The zones quality work runs in; the race zone is the goal race's own pace. */
export type WorkZone = Extract<PaceZone, "threshold" | "interval" | "repetition" | "race">;

/** The work of one quality session: `reps` x `repM` in its zone, easy `recoveryS` after each rep. */
export interface Work {
  zone: WorkZone;
  repM: number;
  reps: number;
  recoveryS: number;
}

export interface QualityWorkInput {
  zone: WorkZone;
  distanceKey: RaceDistanceKey;
  /** The most work the session may hold (workCapM). */
  capM: number;
  /** Tempo blocks rotate by it. */
  weekNumber: number;
  paces: PlanPaces;
}

export interface QualityStepsInput {
  work: Work;
  /** Meters added to the warmup and the cooldown so the session takes volume the easy runs cannot. */
  warmupPadM: number;
  cooldownPadM: number;
  paces: PlanPaces;
}

export const QUALITY_SESSION_TYPE: Readonly<Record<WorkZone, SessionType>> = {
  threshold: "tempo",
  interval: "intervals",
  repetition: "intervals",
  race: "race_practice",
};

/** The session types that hold quality work: intervals, tempo and race practice. */
export const QUALITY_SESSION_TYPES: ReadonlySet<SessionType> = new Set(
  Object.values(QUALITY_SESSION_TYPE),
);

// Build, peak and taper weeks hold 2 quality sessions; a taper keeps the peak's sharpness.
const TWO_QUALITY_PHASES: ReadonlySet<PlanPhase> = new Set(["build", "peak", "taper"]);

/**
 * Base and race weeks hold 1; build, peak and taper 2, leaving at least 2 easy days, so 1 at 3 days. The
 * race week's own sessions come from its template (race-week.ts), not from this count.
 */
export function qualityCount({
  phase,
  daysPerWeek,
}: {
  phase: PlanPhase;
  daysPerWeek: number;
}): number {
  return TWO_QUALITY_PHASES.has(phase) ? Math.min(2, daysPerWeek - 2) : 1;
}

/**
 * Whether a taper week's quality slot keeps its work: race pace until 7 days out, where the race week
 * takes over, tempo until 10 days out; no intervals or repetitions. A slot that does not runs easy.
 */
export function taperKeepsWork({ zone, daysOut }: { zone: WorkZone; daysOut: number }): boolean {
  if (daysOut <= RACE_WEEK_DAYS) return false;
  switch (zone) {
    case "race":
      return true;
    case "threshold":
      return daysOut >= TAPER_TEMPO_MIN_DAYS;
    default:
      return false;
  }
}

/**
 * Each session's zone, first session first. With two, the first alternates intervals (odd weeks) and
 * repetitions (even weeks) in base and build, tempo second; the peak runs race practice and tempo, race
 * practice first in odd weeks and tempo first in even ones, so peak weeks never repeat; the taper runs
 * race practice first. With one, base and build cycle tempo, intervals, tempo, repetitions by week, the
 * peak alternates race practice (odd weeks) and tempo (even weeks), and taper and race weeks run race
 * practice: a runner on one session a week still meets tempo.
 */
export function qualityZones({
  phase,
  weekNumber,
  daysPerWeek,
}: {
  phase: PlanPhase;
  weekNumber: number;
  daysPerWeek: number;
}): WorkZone[] {
  const odd = weekNumber % 2 === 1;
  const early = phase === "base" || phase === "build";
  if (qualityCount({ phase, daysPerWeek }) === 2) {
    if (early) return [odd ? "interval" : "repetition", "threshold"];
    return phase === "peak" && !odd ? ["threshold", "race"] : ["race", "threshold"];
  }
  if (early) return [ONE_QUALITY_ROTATION[(weekNumber - 1) % ONE_QUALITY_ROTATION.length]!];
  return [phase === "peak" && !odd ? "threshold" : "race"];
}

/** The most work one session may hold, as a share of the week's distance, in whole meters. */
export function workCapM(zone: WorkZone, weekVolumeM: number): number {
  return Math.floor(WORK_CAP_SHARE[zone] * weekVolumeM);
}

function fromMenu(
  zone: WorkZone,
  [longer, shorter]: readonly [number, number],
  capM: number,
  recoveryS: number,
): Work | null {
  if (Math.floor(capM / longer) >= MIN_REPS_FOR_LONGER) {
    return { zone, repM: longer, reps: Math.floor(capM / longer), recoveryS };
  }
  const reps = Math.floor(capM / shorter);
  return reps === 0 ? null : { zone, repM: shorter, reps, recoveryS };
}

/**
 * Threshold work in blocks of whole 100 m: the week's count from THRESHOLD_BLOCK_ROTATION, fewer while a
 * block would be under 1 km, none when even one would be; one block only up to 20 min at threshold pace,
 * else 2.
 */
function thresholdWork(
  { distanceKey, capM, weekNumber, paces }: QualityWorkInput,
  zone: WorkZone,
): Work | null {
  const rotation = THRESHOLD_BLOCK_ROTATION[distanceKey];
  const blockM = (blocks: number) =>
    Math.floor(capM / blocks / THRESHOLD_BLOCK_STEP_M) * THRESHOLD_BLOCK_STEP_M;
  let blocks = rotation[(weekNumber - 1) % rotation.length]!;
  while (blocks > 1 && blockM(blocks) < THRESHOLD_BLOCK_MIN_M) blocks -= 1;
  if (blockM(blocks) < THRESHOLD_BLOCK_MIN_M) return null;
  const singleS = stepDurationS(
    { kind: "work", zone: "threshold", distanceM: blockM(1), durationS: null },
    paces,
  );
  if (blocks === 1 && singleS > THRESHOLD_SINGLE_MAX_S) blocks = 2;
  return { zone, repM: blockM(blocks), reps: blocks, recoveryS: THRESHOLD_RECOVERY_S };
}

/**
 * The most work of the zone's menu that fits the cap; null when not even one rep fits. Threshold work
 * rotates its blocks by week (thresholdWork).
 */
export function qualityWork(input: QualityWorkInput): Work | null {
  const { zone, distanceKey, capM } = input;
  switch (zone) {
    case "interval":
      return fromMenu(zone, INTERVAL_REP_M, capM, INTERVAL_RECOVERY_S);
    case "repetition":
      return fromMenu(zone, REPETITION_REP_M, capM, REPETITION_RECOVERY_S);
    case "race":
      return fromMenu(zone, RACE_PRACTICE_REP_M[distanceKey], capM, RACE_PRACTICE_RECOVERY_S);
    case "threshold":
      return thresholdWork(input, zone);
  }
}

/** One rep fewer, or no work at all after the last one. */
export function dropRep(work: Work): Work | null {
  return work.reps === 1 ? null : { ...work, reps: work.reps - 1 };
}

/**
 * Warmup, the work, cooldown. Warmup and cooldown are by time; a padded one is by distance so the
 * session holds exactly the meters the week gave it.
 */
export function qualitySteps({
  work,
  warmupPadM,
  cooldownPadM,
  paces,
}: QualityStepsInput): SessionSteps {
  const padded = (step: Step, padM: number): Step =>
    padM === 0 ? step : { ...step, distanceM: stepDistanceM(step, paces) + padM, durationS: null };
  const rep: Step = { kind: "work", zone: work.zone, distanceM: work.repM, durationS: null };
  return [
    padded({ kind: "warmup", zone: "easy", distanceM: null, durationS: WARMUP_S }, warmupPadM),
    ...(work.reps === 1
      ? [rep]
      : [
          {
            repeat: work.reps,
            steps: [
              rep,
              {
                kind: "recovery",
                zone: "easy",
                distanceM: null,
                durationS: work.recoveryS,
              } as const,
            ],
          },
        ]),
    padded(
      { kind: "cooldown", zone: "easy", distanceM: null, durationS: COOLDOWN_S },
      cooldownPadM,
    ),
  ];
}
