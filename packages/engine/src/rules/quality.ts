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
  RACE_PRACTICE_RECOVERY_S,
  RACE_PRACTICE_REP_M,
  REPETITION_RECOVERY_S,
  REPETITION_REP_M,
  THRESHOLD_BLOCK_STEP_M,
  THRESHOLD_BLOCKS,
  THRESHOLD_RECOVERY_S,
  WARMUP_S,
  WORK_CAP_SHARE,
} from "../constants";
import { stepDistanceM } from "./session-target";

/** The zones quality work runs in; the race zone is the goal race's own pace. */
export type WorkZone = Extract<PaceZone, "threshold" | "interval" | "repetition" | "race">;

/** The work of one quality session: `reps` x `repM` in its zone, easy `recoveryS` after each rep. */
export interface Work {
  zone: WorkZone;
  repM: number;
  reps: number;
  recoveryS: number;
}

export interface QualityStepsInput {
  work: Work;
  /** Meters added to the warmup so the session takes volume the easy runs cannot. */
  warmupPadM: number;
  paces: PlanPaces;
}

export const QUALITY_SESSION_TYPE: Readonly<Record<WorkZone, SessionType>> = {
  threshold: "tempo",
  interval: "intervals",
  repetition: "intervals",
  race: "race_practice",
};

/** Base, taper and race weeks hold 1; build and peak 2, leaving at least 2 easy days, so 1 at 3 days. */
export function qualityCount({
  phase,
  daysPerWeek,
}: {
  phase: PlanPhase;
  daysPerWeek: number;
}): number {
  return phase === "build" || phase === "peak" ? Math.min(2, daysPerWeek - 2) : 1;
}

/**
 * Each session's zone, first session first. The first alternates intervals (odd weeks) and repetitions
 * (even weeks) in base and build, and is race practice from the peak on; the second is always tempo.
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
  const first: WorkZone =
    phase === "base" || phase === "build"
      ? weekNumber % 2 === 1
        ? "interval"
        : "repetition"
      : "race";
  return qualityCount({ phase, daysPerWeek }) === 2 ? [first, "threshold"] : [first];
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

/** The most work of the zone's menu that fits the cap; null when not even one rep fits. */
export function qualityWork({
  zone,
  distanceKey,
  capM,
}: {
  zone: WorkZone;
  distanceKey: RaceDistanceKey;
  capM: number;
}): Work | null {
  switch (zone) {
    case "interval":
      return fromMenu(zone, INTERVAL_REP_M, capM, INTERVAL_RECOVERY_S);
    case "repetition":
      return fromMenu(zone, REPETITION_REP_M, capM, REPETITION_RECOVERY_S);
    case "race":
      return fromMenu(zone, RACE_PRACTICE_REP_M[distanceKey], capM, RACE_PRACTICE_RECOVERY_S);
    case "threshold": {
      const reps = THRESHOLD_BLOCKS[distanceKey];
      const repM = Math.floor(capM / reps / THRESHOLD_BLOCK_STEP_M) * THRESHOLD_BLOCK_STEP_M;
      return repM === 0 ? null : { zone, repM, reps, recoveryS: THRESHOLD_RECOVERY_S };
    }
  }
}

/** One rep fewer, or no work at all after the last one. */
export function dropRep(work: Work): Work | null {
  return work.reps === 1 ? null : { ...work, reps: work.reps - 1 };
}

/**
 * Warmup, the work, cooldown. Warmup and cooldown are by time; a padded warmup is by distance so the
 * session holds exactly the meters the week gave it.
 */
export function qualitySteps({ work, warmupPadM, paces }: QualityStepsInput): SessionSteps {
  const warmup: Step = { kind: "warmup", zone: "easy", distanceM: null, durationS: WARMUP_S };
  const rep: Step = { kind: "work", zone: work.zone, distanceM: work.repM, durationS: null };
  return [
    warmupPadM === 0
      ? warmup
      : { ...warmup, distanceM: stepDistanceM(warmup, paces) + warmupPadM, durationS: null },
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
    { kind: "cooldown", zone: "easy", distanceM: null, durationS: COOLDOWN_S },
  ];
}
