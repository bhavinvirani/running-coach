import {
  distanceInUnits,
  elevationInUnits,
  paceSecondsPerUnit,
  type Activity,
  type Units,
} from "@running-coach/shared";
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

type RunStatsProps = {
  activity: Activity;
  units: Units;
};

/** A figure with its unit, or the dash alone: "– km" would read as a broken value. */
function stat(label: string, value: string, unit?: string) {
  return { label, value, unit: value === MISSING ? undefined : unit };
}

/**
 * The run's summary from the stored activity, in two columns so "1:32:10" fits at text-figure on a phone.
 * Pace is derived from distance and time; anything Garmin did not record shows the dash.
 */
export function RunStats({ activity, units }: RunStatsProps) {
  const flags = [activity.isIndoor ? "Indoor" : null, activity.isManual ? "Manual" : null].filter(
    (flag) => flag !== null,
  );
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
      <p className="text-caption text-ink-2">
        <time dateTime={activity.startLocal}>{formatLocalTime(activity.startLocal)}</time>
        {flags.map((flag) => ` · ${flag}`).join("")}
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5">
        {stats.map(({ label, value, unit }) => (
          <Stat key={label} label={label} value={value} unit={unit} />
        ))}
      </div>
    </section>
  );
}
