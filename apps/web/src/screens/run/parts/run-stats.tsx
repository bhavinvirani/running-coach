import {
  distanceInUnits,
  elevationInUnits,
  paceSecondsPerUnit,
  type Activity,
  type DistanceKey,
  type Units,
} from "@running-coach/shared";
import { DotLine } from "@/components/dot-line";
import { PbChip } from "@/components/pb-chip";
import { RunTypeChip } from "@/components/run-type-chip";
import { Stat } from "@/components/stat";
import {
  MISSING,
  elevationUnitLabel,
  formatCadence,
  formatCalories,
  formatDistanceValue,
  formatDuration,
  formatElevationValue,
  formatHeartRate,
  formatLocalTime,
  formatPaceValue,
  paceUnitLabel,
} from "@/lib/format";
import { runTypeName } from "@/lib/run-type";

type RunStatsProps = {
  activity: Activity;
  units: Units;
  /** The distances at which the run is the runner's current best, shortest first; empty for most runs. */
  bests: readonly DistanceKey[];
};

/** A figure with its unit, or the dash alone: "– km" would read as a broken value. */
function stat(label: string, value: string, unit?: string) {
  return { label, value, unit: value === MISSING ? undefined : unit };
}

/**
 * The run's summary from the stored activity, three stats to a row like Runna's; at 390 px "1:32:10" at
 * text-figure fills its third with under 2 px to spare, so the column gap stays at spacing step 3.
 * Above it the start time, the Race chip for a run marked as a race in Garmin Connect, the PB chip for a
 * run that holds a current best, and Indoor or Manual. Pace is derived from distance and time; anything
 * Garmin did not record shows the dash.
 */
export function RunStats({ activity, units, bests }: RunStatsProps) {
  const elevation =
    activity.elevationGainM === null
      ? MISSING
      : formatElevationValue(elevationInUnits(activity.elevationGainM, units));
  const stats = [
    stat(
      "Distance",
      activity.distanceM > 0
        ? formatDistanceValue(distanceInUnits(activity.distanceM, units))
        : MISSING,
      units,
    ),
    stat("Time", activity.durationS > 0 ? formatDuration(activity.durationS) : MISSING),
    stat(
      "Avg pace",
      formatPaceValue(paceSecondsPerUnit(activity.distanceM, activity.durationS, units)),
      paceUnitLabel(units),
    ),
    stat("Elevation gain", elevation, elevationUnitLabel(units)),
    stat("Avg HR", formatHeartRate(activity.avgHr), "bpm"),
    stat("Cadence", formatCadence(activity.cadence), "spm"),
    stat("Calories", formatCalories(activity.calories), "kcal"),
  ];

  return (
    <section aria-label="Summary" className="flex flex-col gap-4">
      <DotLine className="text-caption text-ink-2">
        <time dateTime={activity.startLocal}>{formatLocalTime(activity.startLocal)}</time>
        {runTypeName(activity.eventType) ? <RunTypeChip eventType={activity.eventType} /> : null}
        {bests.length > 0 ? <PbChip distances={bests} /> : null}
        {activity.isIndoor ? "Indoor" : null}
        {activity.isManual ? "Manual" : null}
      </DotLine>
      <div className="grid grid-cols-3 gap-x-3 gap-y-5">
        {stats.map(({ label, value, unit }) => (
          <Stat key={label} label={label} value={value} unit={unit} />
        ))}
      </div>
    </section>
  );
}
