import type { GeneratedWeek, PlanConflict } from "@running-coach/shared";
import { MIN_RUN_S } from "../constants";

export interface FillWeekInput {
  /** Meters left for the quality sessions and easy runs once the long run is placed. */
  restM: number;
  /** The longest an easy run or a padded quality session may be: the week's long run. */
  capM: number;
  /** Each quality session's meters before padding. */
  qualityM: readonly number[];
  easySlots: number;
  minRunM: number;
}

export interface FillWeekResult {
  /** One per easy run, in slot order; can be fewer than the slots. */
  easyRunsM: number[];
  /** Meters added to each quality session's warmup. */
  qualityPadM: number[];
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** 20 min at the easy midpoint, rounded up so the run is never under 20 min. */
export function minRunDistanceM(easyPaceSPerKm: number): number {
  return Math.ceil((MIN_RUN_S * 1000) / easyPaceSPerKm);
}

/**
 * The days a week of this volume holds with a run of at least 20 min on each, the long run included:
 * at most the days asked for, and at least the long run.
 */
export function daysHeld({
  weekVolumeM,
  daysPerWeek,
  minRunM,
}: {
  weekVolumeM: number;
  daysPerWeek: number;
  minRunM: number;
}): number {
  return Math.max(1, Math.min(daysPerWeek, Math.floor(weekVolumeM / minRunM)));
}

/**
 * Week 1, as built, does not hold a run of at least 20 min on every day the runner asked for: it holds
 * fewer sessions, or its volume is under 20 min a day, which fillWeek meets with runs shorter than
 * 20 min. The long run, then the quality sessions, have already given way. The most days is the fewer
 * of the two. A plan that starts in race week is not judged by it: that week runs only the days before
 * the race, whatever the runner asked for.
 */
export function tooManyDaysConflict({
  daysPerWeek,
  weekOne,
  startVolumeM,
  minRunM,
}: {
  daysPerWeek: number;
  /** Week 1 as built. */
  weekOne: Pick<GeneratedWeek, "phase" | "sessions" | "distanceM">;
  startVolumeM: number;
  minRunM: number;
}): PlanConflict | null {
  if (weekOne.phase === "race") return null;
  const maxDaysPerWeek = Math.min(
    weekOne.sessions.length,
    daysHeld({ weekVolumeM: weekOne.distanceM, daysPerWeek, minRunM }),
  );
  return maxDaysPerWeek < daysPerWeek
    ? { code: "too_many_days", daysPerWeek, maxDaysPerWeek, baselineWeeklyM: startVolumeM }
    : null;
}

/**
 * The easy runs that hold the rest of the week, in equal shares, each at least 20 min and at most the
 * long run. When they would pass the long run, the quality warmups grow first, each up to the long run;
 * what still does not fit is not run. Where 20 min runs would leave a gap (runs of 20 min would pass
 * the long run, one more would be under 20 min), the extra run is shorter but at least half the long
 * run: losing that volume would shrink the week instead. A rest under that goes to the warmups.
 */
export function fillWeek({
  restM,
  capM,
  qualityM,
  easySlots,
  minRunM,
}: FillWeekInput): FillWeekResult {
  const qualityPadM = qualityM.map(() => 0);
  const pad = (meters: number) => {
    let left = meters;
    qualityM.forEach((meters, k) => {
      const take = Math.min(left, Math.max(0, capM - meters) - qualityPadM[k]!);
      qualityPadM[k]! += take;
      left -= take;
    });
  };
  const rest = restM - sum(qualityM);
  if (rest <= 0) return { easyRunsM: [], qualityPadM };
  pad(Math.max(0, rest - easySlots * capM));
  const easyM = Math.min(rest - sum(qualityPadM), easySlots * capM);
  if (easyM < Math.min(minRunM, Math.floor(capM / 2))) {
    pad(easyM);
    return { easyRunsM: [], qualityPadM };
  }
  const runs = Math.min(easySlots, Math.max(Math.floor(easyM / minRunM), Math.ceil(easyM / capM)));
  const share = Math.floor(easyM / runs);
  return {
    easyRunsM: Array.from({ length: runs }, (_, k) => share + (k < easyM - share * runs ? 1 : 0)),
    qualityPadM,
  };
}
