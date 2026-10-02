import {
  distanceInUnits,
  paceSecondsPerUnit,
  type Activity,
  type Units,
} from "@running-coach/shared";
import { Link } from "react-router";
import { MISSING, formatDistance, formatDuration, formatLocalDay, formatPace } from "@/lib/format";
import { progressCopy } from "../progress-copy";

type RunRowProps = {
  run: Activity;
  units: Units;
};

/**
 * One run: its local day, distance, time and pace in fixed columns so figures line up down the week.
 * Pace is derived from distance and time; a run without distance (treadmill, manual) shows the dash for
 * both rather than 0 or a pace from nothing. The whole row opens the run, so it needs no icon.
 */
export function RunRow({ run, units }: RunRowProps) {
  const distance =
    run.distanceM > 0 ? formatDistance(distanceInUnits(run.distanceM, units), units) : MISSING;
  const duration = run.durationS > 0 ? formatDuration(run.durationS) : MISSING;
  const pace = formatPace(paceSecondsPerUnit(run.distanceM, run.durationS, units), units);
  const flags = [
    run.isIndoor ? progressCopy.indoor : null,
    run.isManual ? progressCopy.manual : null,
  ]
    .filter((flag) => flag !== null)
    .join(" · ");
  // Named in words: read from the columns, a screen reader would run "10.0 km" into "52:18".
  const name = [formatLocalDay(run.startLocal), flags, distance, duration, pace]
    .filter((part) => part !== "" && part !== MISSING)
    .join(", ");

  return (
    <li>
      <Link
        to={`/runs/${run.id}`}
        aria-label={name}
        className="flex min-h-12 items-center gap-2 rounded-sm py-3 active:bg-surface-1"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <time dateTime={run.startLocal} className="truncate text-body text-ink">
            {formatLocalDay(run.startLocal)}
          </time>
          {flags ? <span className="text-caption text-ink-2">{flags}</span> : null}
        </div>
        <span className="w-18 shrink-0 text-right text-body text-ink">{distance}</span>
        <span className="w-16 shrink-0 text-right text-body text-ink">{duration}</span>
        <span className="w-22 shrink-0 text-right text-body text-ink">{pace}</span>
      </Link>
    </li>
  );
}
