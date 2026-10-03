import type { RaceDistanceKey } from "@running-coach/shared";
import { TAPER_BLOCK_DAYS, TAPER_FRACTIONS, TAPER_WEEKS } from "../constants";
import { addDays, daysBetween } from "../dates";

export interface TaperDatesInput {
  distanceKey: RaceDistanceKey;
  raceDate: string;
}

export interface TaperBlocksInput extends TaperDatesInput {
  /** The plan's first Monday: a block before it is cut there, or dropped. */
  startDate: string;
}

/** 7 days of the taper, counted back from the race: block 1 is the 7 days before race day. */
export interface TaperBlock {
  number: number;
  firstDate: string;
  lastDate: string;
}

export interface TaperVolumesInput {
  distanceKey: RaceDistanceKey;
  peakVolumeM: number;
  /** Blocks in the plan; fewer than the full taper on a close race. */
  blocks: number;
}

export interface TaperPeakInput {
  /** Every week before the taper that it does not cut into, as built. */
  weeksM: readonly number[];
  startVolumeM: number;
}

/** The taper's first day: 2 weeks before the race, 3 before a marathon, whatever day the race is. */
export function taperStartDate({ distanceKey, raceDate }: TaperDatesInput): string {
  return addDays(raceDate, -TAPER_BLOCK_DAYS * TAPER_WEEKS[distanceKey]);
}

/**
 * The taper's 7-day blocks, oldest first, counted back from race day so the 7 days before any race,
 * whatever its weekday, are one block. A block that starts before the plan is cut at its first day;
 * one that ends before it is dropped.
 */
export function taperBlocks({ distanceKey, raceDate, startDate }: TaperBlocksInput): TaperBlock[] {
  const blocks: TaperBlock[] = [];
  for (let number = TAPER_WEEKS[distanceKey]; number >= 1; number -= 1) {
    const firstDate = addDays(raceDate, -TAPER_BLOCK_DAYS * number);
    const lastDate = addDays(firstDate, TAPER_BLOCK_DAYS - 1);
    if (daysBetween(startDate, lastDate) < 0) continue;
    blocks.push({
      number,
      firstDate: daysBetween(startDate, firstDate) < 0 ? startDate : firstDate,
      lastDate,
    });
  }
  return blocks;
}

/**
 * Each block's volume as a fixed share of the peak, the last block's excluding the race. A short plan
 * keeps the last shares, so its 7 days before the race are still at 40% of the peak. Whole meters
 * rounded up, so no block falls under its share and the last never cuts more than the SPEC's 60%.
 */
export function taperVolumesM({ distanceKey, peakVolumeM, blocks }: TaperVolumesInput): number[] {
  const fractions = TAPER_FRACTIONS[TAPER_WEEKS[distanceKey]]!;
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > fractions.length) {
    throw new RangeError(
      `A ${distanceKey} taper has 1 to ${fractions.length} blocks, got ${blocks}`,
    );
  }
  return fractions.slice(-blocks).map((fraction) => Math.ceil(peakVolumeM * fraction));
}

/**
 * What the taper cuts from: the largest whole week before it as built, so a down week in the peak
 * phase never stands for the peak; the start volume on a plan with no whole week before the taper.
 */
export function taperPeakM({ weeksM, startVolumeM }: TaperPeakInput): number {
  return weeksM.length === 0 ? startVolumeM : Math.max(...weeksM);
}
