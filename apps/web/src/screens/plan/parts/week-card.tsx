import { distanceInUnits, type PlanWeek, type Units } from "@running-coach/shared";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { MISSING, formatDistance, formatDistanceValue, formatWeekRange } from "@/lib/format";
import {
  dayType,
  phaseName,
  planDays,
  weekTitle,
  weekdayInitial,
  weekdayName,
} from "@/lib/plan-week";
import { sessionTypeBackground, sessionTypeName } from "@/lib/session-type";
import { planCopy } from "../plan-copy";

type WeekCardProps = {
  week: PlanWeek;
  units: Units;
  /** The plan's last Monday: a week in another year than the plan's end gets its year. */
  lastWeekStart: string;
  /** The week that holds today, selected with border-line-selected and nothing else. */
  current: boolean;
};

/**
 * One week of the plan: its number and phase, its distance as the figure beside its dates, and a cell per
 * day, Monday to Sunday, with the day's initial over a bar in its session type's color (rest in grey). The
 * whole card opens the week, so it needs no icon; its name says the days in words, which the bars only
 * show.
 */
export function WeekCard({ week, units, lastWeekStart, current }: WeekCardProps) {
  const days = planDays(week);
  const distance =
    week.distanceM > 0 ? formatDistanceValue(distanceInUnits(week.distanceM, units)) : MISSING;
  const range = formatWeekRange(week.startDate, lastWeekStart);
  const name = [
    weekTitle(week.number),
    phaseName(week.phase),
    week.distanceM > 0 ? formatDistance(distanceInUnits(week.distanceM, units), units) : null,
    range,
    current ? planCopy.thisWeek : null,
    ...days.map((day) => `${weekdayName(day.weekday)} ${sessionTypeName(dayType(day))}`),
  ]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <li>
      <Link
        to={`/plan/weeks/${week.number}`}
        aria-label={name}
        className={cn(
          "flex flex-col gap-3 rounded-md border bg-surface-1 p-4 active:bg-surface-2",
          current ? "border-line-selected" : "border-line",
        )}
      >
        <span className="flex items-baseline justify-between gap-4">
          <span className="text-body font-semibold text-ink">{weekTitle(week.number)}</span>
          <span className="text-caption text-ink-2">{phaseName(week.phase)}</span>
        </span>
        <span className="flex items-baseline gap-3">
          <span className="text-figure text-ink">
            {distance}
            {distance === MISSING ? null : (
              <span className="ml-1 text-caption text-ink-2">{units}</span>
            )}
          </span>
          <span className="text-caption text-ink-2">{range}</span>
        </span>
        <span aria-hidden="true" className="grid grid-cols-7 gap-1.5">
          {days.map((day) => (
            <span key={day.date} className="flex flex-col items-center gap-1">
              <span className="text-caption text-ink-2">{weekdayInitial(day.weekday)}</span>
              <span
                className={cn("h-1.5 w-full rounded-full", sessionTypeBackground(dayType(day)))}
              />
            </span>
          ))}
        </span>
      </Link>
    </li>
  );
}

/** A week card at its loaded heights, so nothing jumps when the plan arrives. */
export function WeekCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-1 p-4">
      <div className="flex h-5.5 items-center justify-between">
        <div className="h-4 w-16 rounded-sm bg-surface-2" />
        <div className="h-3 w-10 rounded-sm bg-surface-2" />
      </div>
      <div className="flex h-8.5 items-end gap-3">
        <div className="h-7 w-24 rounded-sm bg-surface-2" />
        <div className="mb-1 h-3 w-14 rounded-sm bg-surface-2" />
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 7 }, (_, position) => (
          <div key={position} className="flex flex-col items-center gap-1">
            <div className="flex h-4 items-center">
              <div className="h-3 w-2 rounded-sm bg-surface-2" />
            </div>
            <div className="h-1.5 w-full rounded-full bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
