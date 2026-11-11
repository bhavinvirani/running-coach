import { DOWN_WEEK_EVERY, DOWN_WEEK_FACTOR, DOWN_WEEK_FIRST } from "../constants";
import { maxWeeklyVolumeM } from "./weekly-volume";

export interface DownWeekInput {
  weekNumber: number;
  /** A race plan's first taper week; null for a fitness plan, which has none. */
  firstTaperWeek: number | null;
}

export interface BaseCurveInput {
  startVolumeM: number;
  peakVolumeM: number;
  /** The pre-taper weeks the curve covers. */
  weeks: number;
}

export type WeekTargetInput =
  /** A pre-taper week that is not a down week, against the last such week as run. */
  | { kind: "climb"; curveM: number; previousNonDownWeekM: number | null }
  /** A down week, against the week before it as built. */
  | { kind: "down"; curveM: number; previousWeekM: number }
  /** A taper week, against the week before it as built (none at the plan's start). */
  | { kind: "eased"; volumeM: number; previousWeekM: number | null };

/**
 * The volume each pre-taper week builds towards: week 1 at the start volume, then +10% a week up to
 * the peak, then holding. A start above the peak holds where the runner already is.
 */
export function baseCurveM({ startVolumeM, peakVolumeM, weeks }: BaseCurveInput): number[] {
  const curve: number[] = [];
  for (let week = 0; week < weeks; week += 1) {
    const previous = curve[week - 1];
    curve.push(
      previous === undefined
        ? startVolumeM
        : Math.max(previous, Math.min(maxWeeklyVolumeM(previous), peakVolumeM)),
    );
  }
  return curve;
}

/**
 * Whether a week recovers; the week after picks the curve up where it was. A race plan counts back from
 * its taper, so the 3 weeks before it always load: a taper from week 19 recovers in weeks 15, 11, 7 and
 * 3, none before week 3. A fitness plan recovers every 4th week: 4, 8 and 12.
 */
export function isDownWeek({ weekNumber, firstTaperWeek }: DownWeekInput): boolean {
  if (firstTaperWeek === null) return weekNumber % DOWN_WEEK_EVERY === 0;
  const weeksBefore = firstTaperWeek - weekNumber;
  return weekNumber >= DOWN_WEEK_FIRST && weeksBefore > 0 && weeksBefore % DOWN_WEEK_EVERY === 0;
}

export function downWeekM(curveM: number): number {
  return Math.floor(curveM * DOWN_WEEK_FACTOR);
}

/**
 * A week's volume target, measured against the weeks as they were actually built: a week that could
 * not hold its volume holds the next one back too, so no week rises more than 10% over what was run,
 * and a down week recovers from the week the runner ran, not from the curve it lagged.
 */
export function weekTargetM(input: WeekTargetInput): number {
  switch (input.kind) {
    case "climb":
      return input.previousNonDownWeekM === null
        ? input.curveM
        : Math.min(input.curveM, maxWeeklyVolumeM(input.previousNonDownWeekM));
    case "down":
      return downWeekM(Math.min(input.curveM, input.previousWeekM));
    case "eased":
      return input.previousWeekM === null
        ? input.volumeM
        : Math.min(input.volumeM, input.previousWeekM);
  }
}
