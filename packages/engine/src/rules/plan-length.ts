import type {
  GoalKind,
  PlanConflict,
  PlanPhase,
  PlanWarning,
  RaceDistanceKey,
} from "@running-coach/shared";
import {
  FITNESS_PHASE_WEEKS,
  FITNESS_PLAN_WEEKS,
  MIN_PLAN_WEEKS,
  PEAK_PHASE_WEEKS,
  TAPER_WEEKS,
} from "../constants";
import { addDays, daysBetween } from "../dates";

export interface PlanLengthInput {
  kind: GoalKind;
  /** The race distance, or the distance a fitness plan is shaped like. */
  distanceKey: RaceDistanceKey;
  /** The plan's first Monday. */
  startDate: string;
  raceDate: string | null;
}

export type PlanLengthResult =
  | { ok: true; phases: PlanPhase[]; endDate: string; warning: PlanWarning | null }
  | { ok: false; conflict: PlanConflict };

function repeat(phase: PlanPhase, count: number): PlanPhase[] {
  return Array.from({ length: count }, () => phase);
}

/**
 * The phase of every week. A race plan ends with its taper, the race week last; a plan at least the
 * distance's minimum puts 2 peak weeks before the taper and a quarter of the rest as base. A shorter
 * plan is the taper weeks that fit, counted back from the race, with build weeks before them.
 */
export function planLength({
  kind,
  distanceKey,
  startDate,
  raceDate,
}: PlanLengthInput): PlanLengthResult {
  if (kind === "fitness") {
    if (raceDate !== null) throw new RangeError("A fitness goal has no race date");
    return {
      ok: true,
      phases: [
        ...repeat("base", FITNESS_PHASE_WEEKS),
        ...repeat("build", FITNESS_PHASE_WEEKS),
        ...repeat("peak", FITNESS_PLAN_WEEKS - 2 * FITNESS_PHASE_WEEKS),
      ],
      endDate: addDays(startDate, FITNESS_PLAN_WEEKS * 7 - 1),
      warning: null,
    };
  }
  if (raceDate === null) throw new RangeError("A race goal needs a race date");
  const daysOut = daysBetween(startDate, raceDate);
  if (daysOut < 0) {
    return { ok: false, conflict: { code: "race_too_soon", raceDate, earliestStart: startDate } };
  }
  const weeks = Math.ceil((daysOut + 1) / 7);
  const minimumWeeks = MIN_PLAN_WEEKS[distanceKey];
  const taperWeeks = Math.min(TAPER_WEEKS[distanceKey], weeks);
  const preTaperWeeks = weeks - taperWeeks;
  const taper = [...repeat("taper", taperWeeks - 1), "race" as const];
  if (weeks < minimumWeeks) {
    return {
      ok: true,
      phases: [...repeat("build", preTaperWeeks), ...taper],
      endDate: raceDate,
      warning: { code: "race_date_close", weeks, minimumWeeks },
    };
  }
  // At the minimum the pre-taper weeks number at least 6, so base and peak never overlap.
  const baseWeeks = Math.floor(preTaperWeeks / 4);
  return {
    ok: true,
    phases: [
      ...repeat("base", baseWeeks),
      ...repeat("build", preTaperWeeks - baseWeeks - PEAK_PHASE_WEEKS),
      ...repeat("peak", PEAK_PHASE_WEEKS),
      ...taper,
    ],
    endDate: raceDate,
    warning: null,
  };
}
