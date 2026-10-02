import type { DistanceKey, GarminRecord, PersonalBest } from "@running-coach/shared";
import { Link } from "react-router";
import { PbDot } from "@/components/pb-chip";
import { cn } from "@/lib/cn";
import { distanceLabel } from "@/lib/distance-labels";
import { formatLocalDate, formatRecordTime } from "@/lib/format";
import { garminRecordLine, progressCopy } from "../progress-copy";

/** A best stays "New" for a week from the run's start. */
const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;

type PersonalBestBadgeProps = {
  distanceKey: DistanceKey;
  /** The runner's best at this distance; undefined until a run covers it. */
  best: PersonalBest | undefined;
  /** Garmin's own record at this distance, when Garmin tracks one. */
  garminRecord: GarminRecord | undefined;
  /** When the bests were read, as epoch ms: the instant "New" is measured from. */
  now: number;
  /** The line above every row but the first. */
  className?: string;
};

/**
 * One distance: its label with the PB marker, the time as Garmin would show it, the run's local date, and
 * Garmin's record beside it for comparison. A best opens its run; a distance not reached yet says so and
 * opens nothing.
 */
export function PersonalBestBadge({
  distanceKey,
  best,
  garminRecord,
  now,
  className,
}: PersonalBestBadgeProps) {
  const label = distanceLabel(distanceKey);
  const garmin = garminRecord ? garminRecordLine(formatRecordTime(garminRecord.timeS)) : null;
  const garminLine = garmin ? <span className="text-caption text-ink-2">{garmin}</span> : null;

  if (best === undefined) {
    return (
      <li className={cn("py-3", className)}>
        <div className="flex flex-col gap-0.5 py-1">
          <span className="text-caption text-ink-2">{label}</span>
          <span className="flex h-8.5 items-center text-body text-ink-2">
            {progressCopy.noRunYet}
          </span>
          {garminLine}
        </div>
      </li>
    );
  }

  const time = formatRecordTime(best.timeS);
  const date = formatLocalDate(best.startLocal);
  const isNew = now - Date.parse(best.startUtc) < NEW_FOR_MS;
  // Named in words: read from the lines, a screen reader would run "5K" into "27:05".
  const name = [label, time, date, garmin, isNew ? progressCopy.newBest : null]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <li className={cn("py-3", className)}>
      <Link
        to={`/runs/${best.activityId}`}
        aria-label={name}
        className="-mx-2 flex flex-col gap-0.5 rounded-sm px-2 py-1 active:bg-surface-2"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-caption text-ink-2">
            <PbDot />
            {label}
          </span>
          {isNew ? (
            <span className="rounded-full bg-surface-2 px-2 text-caption font-semibold text-ink">
              {progressCopy.newBest}
            </span>
          ) : null}
        </span>
        <span className="text-figure text-ink">{time}</span>
        <time dateTime={best.startLocal} className="text-caption text-ink-2">
          {date}
        </time>
        {garminLine}
      </Link>
    </li>
  );
}
