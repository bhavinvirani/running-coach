import {
  distanceInUnits,
  paceSecondsPerUnit,
  type Activity,
  type DistanceKey,
  type Units,
} from "@running-coach/shared";
import { Link } from "react-router";
import { DotLine } from "@/components/dot-line";
import { PbChip } from "@/components/pb-chip";
import { RunTypeChip } from "@/components/run-type-chip";
import { Stat } from "@/components/stat";
import { personalBestName } from "@/lib/distance-labels";
import {
  MISSING,
  formatDistanceValue,
  formatDuration,
  formatHeartRate,
  formatLocalDateTime,
  formatPaceValue,
  paceUnitLabel,
} from "@/lib/format";
import { runTypeName } from "@/lib/run-type";

type LatestRunProps = {
  activity: Activity;
  units: Units;
  /** The distances the run holds as current bests, shortest first; empty when it holds none. */
  bests: readonly DistanceKey[];
};

/**
 * The newest run: its local start with the Race chip, the PB chip and Indoor when they apply, distance as
 * the one hero number on Today, then time, pace and avg HR.
 * Pace is derived here from distance and time; an indoor run without a footpod has neither distance nor pace.
 * The whole card opens the run.
 */
export function LatestRun({ activity, units, bests }: LatestRunProps) {
  const distance =
    activity.distanceM > 0
      ? formatDistanceValue(distanceInUnits(activity.distanceM, units))
      : MISSING;
  const pace = formatPaceValue(paceSecondsPerUnit(activity.distanceM, activity.durationS, units));
  const avgHr = formatHeartRate(activity.avgHr);
  const typeName = runTypeName(activity.eventType);
  const bestName = personalBestName(bests);
  // Named in words: read from the figures, a screen reader would run "10.0km" into "52:18".
  const name = [
    "Open the latest run",
    formatLocalDateTime(activity.startLocal),
    typeName,
    bestName,
    distance === MISSING ? null : `${distance} ${units}`,
    formatDuration(activity.durationS),
  ]
    .filter((part) => part !== null && part !== MISSING)
    .join(", ");

  return (
    <section aria-label="Latest run" className="border-t border-line pt-4">
      <Link
        to={`/runs/${activity.id}`}
        aria-label={name}
        className="flex flex-col gap-4 rounded-sm active:bg-surface-1"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="shrink-0 text-body font-semibold text-ink">Latest run</h2>
          <DotLine className="justify-end text-body text-ink-2">
            <time dateTime={activity.startLocal}>{formatLocalDateTime(activity.startLocal)}</time>
            {typeName ? <RunTypeChip eventType={activity.eventType} /> : null}
            {bestName ? <PbChip distances={bests} /> : null}
            {activity.isIndoor ? "Indoor" : null}
          </DotLine>
        </div>
        <HeroFigure
          label="Distance"
          value={distance}
          unit={distance === MISSING ? undefined : units}
        />
        {/* Natural widths, not three equal columns: "1:32:10" at text-figure is wider than a third of 390 px. */}
        <div className="flex flex-wrap justify-between gap-4 border-t border-line pt-4">
          <Stat label="Time" value={formatDuration(activity.durationS)} />
          <Stat
            label="Pace"
            value={pace}
            unit={pace === MISSING ? undefined : paceUnitLabel(units)}
          />
          <Stat label="Avg HR" value={avgHr} unit={avgHr === MISSING ? undefined : "bpm"} />
        </div>
      </Link>
    </section>
  );
}

/** Stat's shape one size up, for the single hero number Today allows. */
function HeroFigure({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-ink-2">{label}</span>
      <span className="text-figure-lg text-ink">
        {value}
        {unit ? <span className="ml-1 text-body text-ink-2">{unit}</span> : null}
      </span>
    </div>
  );
}
