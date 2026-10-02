import type { PlanBaseline, PlanWarning, RaceDistanceKey } from "@running-coach/shared";
import { START_VOLUME_FLOOR_M } from "../constants";
import { reEntryFactor } from "./re-entry";

export interface StartVolumeInput {
  baseline: PlanBaseline;
  distanceKey: RaceDistanceKey;
}

export interface StartVolumeResult {
  startVolumeM: number;
  warning: PlanWarning | null;
}

/** Mean of the baseline weeks with running: a week off is not a week of zero training, 0 with none. */
export function recentVolumeM(weeklyVolumesM: readonly number[]): number {
  const running = weeklyVolumesM.filter((m) => m > 0);
  return running.length === 0 ? 0 : running.reduce((sum, m) => sum + m, 0) / running.length;
}

/** Week 1's volume: recent volume after re-entry, never under the distance's floor. */
export function startVolume({ baseline, distanceKey }: StartVolumeInput): StartVolumeResult {
  const reEntered = Math.floor(
    recentVolumeM(baseline.weeklyVolumesM) * reEntryFactor(baseline.daysSinceLastRun),
  );
  const startVolumeM = Math.max(reEntered, START_VOLUME_FLOOR_M[distanceKey]);
  const noRecentRuns = baseline.weeklyVolumesM.every((m) => m === 0);
  return {
    startVolumeM,
    warning: noRecentRuns ? { code: "no_recent_runs", startVolumeM } : null,
  };
}
