import {
  COOLDOWN_MAX_S,
  COOLDOWN_S,
  FLOAT_TOLERANCE,
  MIN_RUN_S,
  WARMUP_MAX_S,
  WARMUP_PAD_SHARE,
  WARMUP_S,
} from "../constants";
import { easyRunCapM, easySplitM } from "./easy-split";
import { roundedRunsM } from "./run-rounding";
import { distanceForDurationM } from "./session-target";

export interface FillWeekInput {
  /** Meters left for the quality sessions and easy runs once the long run is placed. */
  restM: number;
  /** The week's long run: no easy run passes 85% of it (easyRunCapM), no padded session passes it. */
  longM: number;
  /** Each quality session's meters before padding. */
  qualityM: readonly number[];
  /** Each easy day's weekday (0 for Monday), in fill order: fewer runs take the first days. */
  easyDays: readonly number[];
  /** The weekday after the long run's: its easy run takes the smallest share. */
  afterLongDay: number;
  /** Easy shares alternate their order by it. */
  weekNumber: number;
  minRunM: number;
  /** The easy midpoint, the pace warm-ups and cool-downs are planned at. */
  easyPaceSPerKm: number;
  /** A week before the taper keeps every easy day while half the cap fits on each. */
  keepDays: boolean;
}

export interface QualityPad {
  /** Meters added to the warm-up. */
  warmupM: number;
  /** Meters added to the cool-down. */
  cooldownM: number;
}

export interface FillWeekResult {
  /** One per easy run, on the first easy days in fill order; can be fewer than the days. */
  easyRunsM: number[];
  /** One per quality session. */
  qualityPadM: QualityPad[];
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** 20 min at the easy midpoint, rounded up so the run is never under 20 min. */
export function minRunDistanceM(easyPaceSPerKm: number): number {
  return Math.ceil((MIN_RUN_S * 1000) / easyPaceSPerKm);
}

/** The meters a step of `baseS` may grow by before it takes `maxS` at the easy midpoint. */
function padMaxM(baseS: number, maxS: number, easyPaceSPerKm: number): number {
  return distanceForDurationM(maxS, easyPaceSPerKm) - Math.round((baseS * 1000) / easyPaceSPerKm);
}

/**
 * The easy runs that hold the rest of the week, then what they cannot hold. Easy runs take their
 * shares (easy-split.ts), each at least 20 min and at most 85% of the long run, in whole 500 m with
 * the remainder on the longest (run-rounding.ts). Fewer runs than days when the rest holds only
 * that many 20 min runs (as many runs at the cap where it is under 20 min), never shorter ones: a
 * taper week runs fewer, longer runs. A week before the taper keeps every day while half the cap
 * fits on each, in equal runs under 20 min where 20 min runs would drop a day, as a down week at
 * the 20 min floor needs. Easy runs fill to their caps first; what passes them, and a rest under
 * one such run, goes to the quality sessions in equal shares, 60% to the warm-up and 40% to the
 * cool-down, each step at most 25 min and never past the long run. What still does not fit is not
 * run: the week builder then shortens the long run to its share of the week as built.
 */
export function fillWeek({
  restM,
  longM,
  qualityM,
  easyDays,
  afterLongDay,
  weekNumber,
  minRunM,
  easyPaceSPerKm,
  keepDays,
}: FillWeekInput): FillWeekResult {
  const capM = easyRunCapM({ longM, minRunM });
  const easyM = Math.min(restM - sum(qualityM), easyDays.length * capM);
  const halfCapM = Math.min(minRunM, Math.floor(capM / 2));
  // The shortest easy run: 20 min, or the cap where a long run under 20 min holds it lower.
  const fewestM = Math.min(minRunM, capM);
  // No easy meters, no runs; else every day before the taper while half the cap fits on each, else
  // as many runs as hold the shortest easy run each.
  const runs =
    easyM <= 0
      ? 0
      : keepDays && easyM >= easyDays.length * halfCapM
        ? easyDays.length
        : Math.min(easyDays.length, Math.floor(easyM / fewestM));
  // Runs at the cap hold less than the rest when fewer of them run.
  const placedM = Math.min(easyM, runs * capM);
  let easyRunsM: number[] = [];
  if (runs > 0 && placedM >= runs * minRunM) {
    const split = easySplitM({
      totalM: placedM,
      days: easyDays.slice(0, runs),
      afterLongDay,
      weekNumber,
      minM: minRunM,
      maxM: capM,
    });
    easyRunsM = roundedRunsM({ runsM: split, capM, minRunM });
  } else if (runs > 0) {
    const share = Math.floor(placedM / runs);
    easyRunsM = Array.from(
      { length: runs },
      (_, k) => share + (k < placedM - share * runs ? 1 : 0),
    );
  }

  const overflowM = restM - sum(qualityM) - sum(easyRunsM);
  const warmupMaxM = padMaxM(WARMUP_S, WARMUP_MAX_S, easyPaceSPerKm);
  const cooldownMaxM = padMaxM(COOLDOWN_S, COOLDOWN_MAX_S, easyPaceSPerKm);
  // Equal shares, the odd meters to the first sessions.
  const shareM = Math.floor(overflowM / qualityM.length);
  const qualityPadM = qualityM.map((meters, k) => {
    if (overflowM <= 0) return { warmupM: 0, cooldownM: 0 };
    const ownM = shareM + (k < overflowM - shareM * qualityM.length ? 1 : 0);
    const takeM = Math.min(ownM, Math.max(0, longM - meters));
    const warmupM = Math.floor(takeM * WARMUP_PAD_SHARE + FLOAT_TOLERANCE);
    return {
      warmupM: Math.min(warmupM, warmupMaxM),
      cooldownM: Math.min(takeM - warmupM, cooldownMaxM),
    };
  });
  return { easyRunsM, qualityPadM };
}
