import type { PlanPhase, RaceDistanceKey } from "@running-coach/shared";
import { TAPER_FRACTIONS, TAPER_WEEKS } from "../constants";

export interface TaperVolumesInput {
  distanceKey: RaceDistanceKey;
  peakVolumeM: number;
  /** Taper weeks in the plan, the race week included; fewer than the full taper on a close race. */
  weeks: number;
}

export interface PeakPhaseVolumeInput {
  /** The weeks built so far, in order. */
  weeks: readonly { phase: PlanPhase; distanceM: number }[];
  startVolumeM: number;
}

/**
 * Each taper week's volume as a fixed share of the peak, the race week's excluding the race. A short
 * plan keeps the last shares, so its race week is still at 40% of the peak. Whole meters rounded up,
 * so no week falls under its share and the race week never cuts more than the SPEC's 60%.
 */
export function taperVolumesM({ distanceKey, peakVolumeM, weeks }: TaperVolumesInput): number[] {
  const fractions = TAPER_FRACTIONS[TAPER_WEEKS[distanceKey]]!;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > fractions.length) {
    throw new RangeError(`A ${distanceKey} taper has 1 to ${fractions.length} weeks, got ${weeks}`);
  }
  return fractions.slice(-weeks).map((fraction) => Math.ceil(peakVolumeM * fraction));
}

/**
 * What the taper cuts from: the largest peak-phase week as built, else the largest pre-taper week on a
 * plan too short for a peak, else the start volume on a plan that is all taper.
 */
export function peakPhaseVolumeM({ weeks, startVolumeM }: PeakPhaseVolumeInput): number {
  const largest = (phases: readonly PlanPhase[]) =>
    Math.max(
      0,
      ...weeks.filter((week) => phases.includes(week.phase)).map((week) => week.distanceM),
    );
  return largest(["peak"]) || largest(["base", "build"]) || startVolumeM;
}
