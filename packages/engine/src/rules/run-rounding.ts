import { RUN_ROUND_M } from "../constants";

export interface RoundedRunsInput {
  /** The week's easy runs, in whole meters. */
  runsM: readonly number[];
  /** No run over this: easyRunCapM of the week's long run. */
  capM: number;
  /** 20 min at the easy midpoint. */
  minRunM: number;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** A run down to whole 500 m, or as it is when that would be under 20 min. */
export function roundedRunM(runM: number, minRunM: number): number {
  const rounded = Math.floor(runM / RUN_ROUND_M) * RUN_ROUND_M;
  return rounded >= minRunM ? rounded : runM;
}

/**
 * The week's easy runs in whole 500 m, the longest (the first of equal ones) carrying the meters the
 * others gave up, so the week's total stays exact; as they are when that would take the longest past
 * its cap. A run whose 500 m step would be under 20 min keeps its meters.
 */
export function roundedRunsM({ runsM, capM, minRunM }: RoundedRunsInput): number[] {
  if (runsM.length === 0) return [];
  const longest = runsM.indexOf(Math.max(...runsM));
  const rounded = runsM.map((runM) => roundedRunM(runM, minRunM));
  const carriedM = rounded[longest]! + sum(runsM) - sum(rounded);
  if (carriedM > capM) return [...runsM];
  rounded[longest] = carriedM;
  return rounded;
}
