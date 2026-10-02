import {
  distanceInUnits,
  paceSecondsPerUnit,
  type Activity,
  type Units,
} from "@running-coach/shared";
import { Stat } from "@/components/stat";
import {
  MISSING,
  formatDistanceValue,
  formatDuration,
  formatHeartRate,
  formatLocalDateTime,
  formatPaceValue,
  paceUnitLabel,
} from "@/lib/format";

type LatestRunProps = {
  activity: Activity;
  units: Units;
};

/**
 * The newest run: its local start, distance as the one hero number on Today, then time, pace and avg HR.
 * Pace is derived here from distance and time; an indoor run without a footpod has neither distance nor pace.
 */
export function LatestRun({ activity, units }: LatestRunProps) {
  const distance =
    activity.distanceM > 0
      ? formatDistanceValue(distanceInUnits(activity.distanceM, units))
      : MISSING;
  const pace = formatPaceValue(paceSecondsPerUnit(activity.distanceM, activity.durationS, units));
  const avgHr = formatHeartRate(activity.avgHr);

  return (
    <section aria-label="Latest run" className="flex flex-col gap-4 border-t border-line pt-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-body font-semibold text-ink">Latest run</h2>
        <p className="text-body text-ink-2">
          <time dateTime={activity.startLocal}>{formatLocalDateTime(activity.startLocal)}</time>
          {activity.isIndoor ? " · Indoor" : null}
        </p>
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
