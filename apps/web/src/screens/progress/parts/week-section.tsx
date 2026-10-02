import { distanceInUnits, type ActivityWeek, type Units } from "@running-coach/shared";
import { MISSING, formatDistanceValue, formatDuration } from "@/lib/format";
import { progressCopy } from "../progress-copy";
import { RunRow } from "./run-row";

type WeekSectionProps = {
  week: ActivityWeek;
  /** The week's range, already formatted: "21–27 Sep". */
  label: string;
  units: Units;
};

/** One Monday-to-Sunday week: its range, total distance as the figure with total time beside it, its runs. */
export function WeekSection({ week, label, units }: WeekSectionProps) {
  const distance =
    week.distanceM > 0 ? formatDistanceValue(distanceInUnits(week.distanceM, units)) : MISSING;
  const time = week.durationS > 0 ? formatDuration(week.durationS) : MISSING;

  return (
    <section aria-label={label} className="flex flex-col gap-2 border-t border-line pt-4">
      <h2 className="text-body font-semibold text-ink">{label}</h2>
      <p className="flex items-baseline gap-3">
        <span className="text-figure text-ink">
          {distance}
          {distance === MISSING ? null : (
            <span className="ml-1 text-caption text-ink-2">{units}</span>
          )}
        </span>
        <span className="text-caption text-ink-2">{time}</span>
      </p>
      <ul aria-label={progressCopy.weekRuns} className="flex flex-col divide-y divide-line">
        {week.runs.map((run) => (
          <RunRow key={run.id} run={run} units={units} />
        ))}
      </ul>
    </section>
  );
}
