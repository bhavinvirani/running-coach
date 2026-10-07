import { EASY_RUN_MAX_SHARE_OF_LONG, EASY_SPLIT, FLOAT_TOLERANCE } from "../constants";

export interface EasySharesInput {
  /** Each easy run's weekday, 0 for Monday, in any order; the result follows it. */
  days: readonly number[];
  /** The weekday after the long run's: its run takes the smallest share. */
  afterLongDay: number;
  /** Odd weeks give the larger shares in date order, even weeks in reverse date order. */
  weekNumber: number;
}

export interface EasySplitInput extends EasySharesInput {
  /** The meters the easy runs hold together. */
  totalM: number;
  /** No run under this: 20 min at the easy midpoint. */
  minM: number;
  /** No run over this: easyRunCapM of the week's long run. */
  maxM: number;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * The longest an easy run may be: 85% of the week's long run, in whole meters. Where that is under
 * 20 min the 20 min floor wins, so every day asked for still runs, though never past the long run.
 */
export function easyRunCapM({ longM, minRunM }: { longM: number; minRunM: number }): number {
  // The nudge keeps 85% of a long run that lands on a whole meter on it (0.85 x 20 000 = 16 999.99...).
  return Math.max(
    Math.floor(EASY_RUN_MAX_SHARE_OF_LONG * longM + FLOAT_TOLERANCE),
    Math.min(minRunM, longM),
  );
}

/**
 * Each easy run's share of the week's easy meters, in percent (EASY_SPLIT): the run the day after the
 * long run takes the smallest, the others the larger shares largest first, in date order in odd weeks
 * and in reverse date order in even ones, so weeks of the same volume do not repeat. More runs than the
 * split covers is a programmer error: 6 days hold at most 5 easy runs.
 */
export function easySharesPercent({ days, afterLongDay, weekNumber }: EasySharesInput): number[] {
  const split = EASY_SPLIT[days.length];
  if (split === undefined) throw new RangeError(`No easy split for ${days.length} runs`);
  const after = days.indexOf(afterLongDay);
  const odd = weekNumber % 2 === 1;
  const ranked = [...days.keys()]
    .filter((k) => k !== after)
    .sort((a, b) => (odd ? days[a]! - days[b]! : days[b]! - days[a]!));
  const shares = days.map(() => split.at(-1)!);
  ranked.forEach((k, rank) => {
    shares[k] = split[rank]!;
  });
  return shares;
}

/**
 * The week's easy runs from their shares, each between `minM` and `maxM`: a run its share puts over
 * the cap holds the cap and one under the floor the floor, the others sharing what is left by their
 * shares. Whole meters, the total exact: the meters whole division leaves go to the larger shares
 * first. Exact integer arithmetic, so the same input gives the same meters. A total the runs cannot
 * hold between the floor and the cap is a programmer error.
 */
export function easySplitM(input: EasySplitInput): number[] {
  const { totalM, minM, maxM } = input;
  const n = input.days.length;
  if (!(minM <= maxM && n * minM <= totalM && totalM <= n * maxM)) {
    throw new RangeError(`${n} runs of ${minM} to ${maxM} m cannot hold ${totalM} m`);
  }
  const shares = easySharesPercent(input);
  // Smallest share first: at any scale, the runs at the floor are the smallest shares and the runs at
  // the cap the largest, so a count at each end names a candidate. At least one run stays free: where
  // every run sits at a bound, the one that just reached it is free at exactly that bound.
  const order = [...shares.keys()].sort((a, b) => shares[a]! - shares[b]!);
  const candidates = order.flatMap((_, atMin) =>
    order.slice(atMin).map((__, atMax) => ({ atMin, atMax })),
  );
  const fits = ({ atMin, atMax }: { atMin: number; atMax: number }) => {
    const free = order.slice(atMin, n - atMax);
    const leftM = totalM - atMin * minM - atMax * maxM;
    const weight = sum(free.map((k) => shares[k]!));
    // At the scale leftM / weight, each free run's share sits between the floor and the cap, and each
    // clamped run's share puts it past its bound.
    const at = (k: number) => shares[k]! * leftM;
    return (
      order.slice(0, atMin).every((k) => at(k) <= minM * weight) &&
      order.slice(n - atMax).every((k) => at(k) >= maxM * weight) &&
      free.every((k) => at(k) >= minM * weight && at(k) <= maxM * weight)
    );
  };
  const { atMin, atMax } = candidates.find(fits)!;
  const free = order.slice(atMin, n - atMax);
  const leftM = totalM - atMin * minM - atMax * maxM;
  const weight = sum(free.map((k) => shares[k]!));
  const runs = shares.map(() => minM);
  order.slice(n - atMax).forEach((k) => {
    runs[k] = maxM;
  });
  free.forEach((k) => {
    runs[k] = Math.floor((shares[k]! * leftM) / weight);
  });
  let spare = leftM - sum(free.map((k) => runs[k]!));
  for (const k of [...free].reverse()) {
    if (spare > 0 && (shares[k]! * leftM) % weight !== 0) {
      runs[k]! += 1;
      spare -= 1;
    }
  }
  return runs;
}
