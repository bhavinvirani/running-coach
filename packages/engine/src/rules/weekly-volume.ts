import { WEEKLY_VOLUME_MAX_INCREASE } from "../constants";

export interface WeeklyVolumeInput {
  previousWeekM: number;
  proposedM: number;
}

export interface WeeklyVolumeResult {
  volumeM: number;
  clamped: boolean;
}

/**
 * Highest volume allowed this week, in whole meters. Flooring keeps the result deterministic and
 * under the cap despite float error. A week after zero volume belongs to the re-entry rule, so a
 * previous week that is not finite and positive is a programmer error.
 */
export function maxWeeklyVolumeM(previousWeekM: number): number {
  if (!Number.isFinite(previousWeekM) || previousWeekM <= 0) {
    throw new RangeError(`previousWeekM must be finite and > 0, got ${previousWeekM}`);
  }
  return Math.floor(previousWeekM * (1 + WEEKLY_VOLUME_MAX_INCREASE));
}

export function clampWeeklyVolume({
  previousWeekM,
  proposedM,
}: WeeklyVolumeInput): WeeklyVolumeResult {
  const maxM = maxWeeklyVolumeM(previousWeekM);
  if (!Number.isFinite(proposedM) || proposedM < 0) {
    throw new RangeError(`proposedM must be finite and >= 0, got ${proposedM}`);
  }
  return proposedM > maxM
    ? { volumeM: maxM, clamped: true }
    : { volumeM: proposedM, clamped: false };
}
