import {
  DISTANCE_METERS,
  paceSecondsPerUnit,
  type RunBestEffort,
  type Units,
} from "@running-coach/shared";
import { PbDot } from "@/components/pb-chip";
import { distanceLabel } from "@/lib/distance-labels";
import { formatPace, formatRecordTime, recordSeconds } from "@/lib/format";
import { RunSection } from "./run-section";

type BestEffortsProps = {
  /** Shortest first (`inDistanceOrder` in best-effort-order.ts). */
  efforts: readonly RunBestEffort[];
  units: Units;
};

/**
 * The run's fastest stretch at each distance it covered: the distance, the time cut to the second as
 * Garmin shows it, the pace in the runner's unit, and PB at the end of a row that is the runner's current
 * best. Fixed columns, like the Progress run rows, so the figures line up down the card. Nothing at all
 * for a run without efforts (not computed yet, or a run the bests leave out: indoor, manual, under 1 km),
 * so the section needs no empty state.
 */
export function BestEfforts({ efforts, units }: BestEffortsProps) {
  if (efforts.length === 0) return null;

  return (
    <RunSection title="Best efforts" className="mt-2">
      <ul aria-label="Best efforts" className="-my-1.5 flex flex-col divide-y divide-line">
        {efforts.map((effort) => (
          <EffortRow key={effort.distanceKey} effort={effort} units={units} />
        ))}
      </ul>
    </RunSection>
  );
}

/**
 * One distance. A screen reader hears the row as one sentence in words, "5K, 27:05, 5:25 /km, personal
 * best": read column by column it would run "5K" into "27:05". The PB marker is the gold dot and the word,
 * never the color alone.
 */
function EffortRow({ effort, units }: { effort: RunBestEffort; units: Units }) {
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
    <li className="flex min-h-11 items-center gap-2">
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" className="min-w-0 flex-1 truncate text-body text-ink">
        {label}
      </span>
      <span
        aria-hidden="true"
        className="w-18 shrink-0 text-right text-body font-semibold text-ink"
      >
        {time}
      </span>
      <span aria-hidden="true" className="w-22 shrink-0 text-right text-body text-ink-2">
        {pace}
      </span>
      <span
        aria-hidden="true"
        className="flex w-11 shrink-0 items-center justify-end gap-1.5 text-caption font-semibold text-ink"
      >
        {effort.personalBest ? (
          <>
            <PbDot />
            PB
          </>
        ) : null}
      </span>
    </li>
  );
}
