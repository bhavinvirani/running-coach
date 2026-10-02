import {
  DISTANCE_METERS,
  paceSecondsPerUnit,
  type RunBestEffort,
  type Units,
} from "@running-coach/shared";
import { longestFirst } from "@/components/best-effort-order";
import { BestEffortRow, BestEffortTile } from "@/components/best-effort-row";
import { distanceLabel } from "@/lib/distance-labels";
import { formatPace, formatRecordTime, recordSeconds } from "@/lib/format";
import { RunSection } from "./run-section";

const TITLE = "Best efforts";
/** On a tile the run holds as the runner's current best, in the New chip's place on Progress. */
const PB_CHIP = "PB";

type BestEffortsProps = {
  /** In any order: the tiles go longest first. */
  efforts: readonly RunBestEffort[];
  units: Units;
};

/**
 * The run's fastest stretch at each distance it covered, as the row of tiles Progress shows its bests in,
 * longest first: the distance with the PB dot and a PB chip where it is the runner's current best, the
 * time cut to the second as Garmin shows it, and the pace in the runner's unit. Not links: the runner is
 * on this run already. Nothing at all for a run without efforts (not computed yet, or a run the bests
 * leave out: indoor, manual, under 1 km), so the section needs no empty state.
 */
export function BestEfforts({ efforts, units }: BestEffortsProps) {
  if (efforts.length === 0) return null;

  return (
    <RunSection title={TITLE} className="mt-2" card={false}>
      <BestEffortRow label={TITLE}>
        {longestFirst(efforts).map((effort) => (
          <EffortTile key={effort.distanceKey} effort={effort} units={units} />
        ))}
      </BestEffortRow>
    </RunSection>
  );
}

/**
 * One distance. A screen reader hears the tile as one sentence in words, "5K, 27:05, 5:25 /km, personal
 * best"; the PB marker is the gold dot and the word, never the color alone.
 */
function EffortTile({ effort, units }: { effort: RunBestEffort; units: Units }) {
  const label = distanceLabel(effort.distanceKey);
  const time = formatRecordTime(effort.timeS);
  // From the time as shown, so a 1K that reads 4:50 never reads 4:51 /km beside it.
  const pace = formatPace(
    paceSecondsPerUnit(DISTANCE_METERS[effort.distanceKey], recordSeconds(effort.timeS), units),
    units,
  );
  const name = [label, time, pace, effort.personalBest ? "personal best" : null]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <BestEffortTile
      label={label}
      name={name}
      personalBest={effort.personalBest}
      chip={effort.personalBest ? PB_CHIP : undefined}
      time={time}
      captions={[{ text: pace }]}
    />
  );
}
