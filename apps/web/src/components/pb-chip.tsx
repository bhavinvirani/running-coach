import type { DistanceKey } from "@running-coach/shared";
import { personalBestName } from "@/lib/distance-labels";

type PbChipProps = {
  /** The distances the run holds as current bests, shortest first; empty for a run that holds none. */
  distances: readonly DistanceKey[];
};

/**
 * "PB 5K, 10K" beside a dot in the PB gold, so a run that set a best stands out in Progress and on Today,
 * the flag a sync leaves once the run's best efforts are in. Like RunTypeChip, the words take the size and
 * color of the line they sit in and the dot is the emphasis; `pb` appears only as this dot and on the
 * badges (web-ui rule). Nothing for a run that holds no best.
 */
export function PbChip({ distances }: PbChipProps) {
  const name = personalBestName(distances);
  if (name === null) return null;

  return (
    <span className="inline-flex items-center gap-2">
      <PbDot />
      {name}
    </span>
  );
}

/** The PB gold marker alone, for a personal-best badge's label. */
export function PbDot() {
  return <span aria-hidden="true" className="size-3 shrink-0 rounded-sm bg-pb" />;
}
