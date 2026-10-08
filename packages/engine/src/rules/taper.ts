export interface TaperPeakInput {
  /** Every week before the taper, as built. */
  weeksM: readonly number[];
  startVolumeM: number;
}

/**
 * What the taper cuts from: the largest week before it as built, so a down week in the peak phase never
 * stands for the peak; the start volume on a plan with no week before the taper. Each taper week's share
 * of it comes from taper-share.ts.
 */
export function taperPeakM({ weeksM, startVolumeM }: TaperPeakInput): number {
  return weeksM.length === 0 ? startVolumeM : Math.max(...weeksM);
}
