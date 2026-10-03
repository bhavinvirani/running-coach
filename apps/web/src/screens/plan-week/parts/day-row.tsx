import {
  distanceInUnits,
  type PlanPaces,
  type PlanSession,
  type Units,
} from "@running-coach/shared";
import { Link } from "react-router";
import { SessionTypeChip } from "@/components/session-type-chip";
import { cn } from "@/lib/cn";
import { describeSteps } from "@/lib/describe-steps";
import { formatDistance, formatDuration, formatLocalDay } from "@/lib/format";
import type { PlanDay } from "@/lib/plan-week";
import { sessionName } from "@/lib/workout-steps";
import { planWeekCopy } from "../plan-week-copy";

type DayRowProps = {
  day: PlanDay;
  paces: PlanPaces;
  units: Units;
  /** The runner's local date: days from it on can take a workout of the runner's own. */
  today: string;
};

/**
 * One day of the week: its date, with Add from today on, then each session as its type chip with distance
 * and time on the right and its steps in one line under it (a lone run's pace band, so the distance is not
 * said twice), paces in the runner's unit. Each session opens its own screen. A day without a session
 * reads Rest; a skipped session reads Skipped, with nothing left to run.
 */
export function DayRow({ day, paces, units, today }: DayRowProps) {
  const label = formatLocalDay(day.date);
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex items-center justify-between gap-4">
        <time dateTime={day.date} className="text-caption text-ink-2">
          {label}
        </time>
        {day.date >= today ? (
          // A 44 px target inside the caption's line height: it overhangs into the row's padding instead
          // of making days with Add taller than past ones.
          <span className="flex h-4 items-center">
            <Link
              to={`/plan/sessions/new?date=${day.date}`}
              aria-label={planWeekCopy.addOn(label)}
              className="-mr-2 flex min-h-11 min-w-11 items-center justify-center rounded-sm text-caption font-semibold text-ink active:bg-surface-2"
            >
              {planWeekCopy.add}
            </Link>
          </span>
        ) : null}
      </div>
      {day.sessions.length === 0 ? (
        <p className="text-body text-ink">
          <SessionTypeChip type="rest" />
        </p>
      ) : (
        day.sessions.map((session) => (
          <SessionLines
            key={session.id}
            session={session}
            day={label}
            paces={paces}
            units={units}
          />
        ))
      )}
    </li>
  );
}

function SessionLines({
  session,
  day,
  paces,
  units,
}: {
  session: PlanSession;
  /** The day as the row shows it, for the link's name. */
  day: string;
  paces: PlanPaces;
  units: Units;
}) {
  const skipped = session.status === "skipped";
  const { distanceM, durationS } = session.target;
  const distance =
    !skipped && distanceM > 0 ? formatDistance(distanceInUnits(distanceM, units), units) : null;
  const duration = !skipped && durationS > 0 ? formatDuration(durationS) : null;
  const steps = skipped ? "" : describeSteps(session.steps, paces, units);
  const name = sessionName(session);
  const label = [name, day, ...(skipped ? [planWeekCopy.skipped] : [distance, duration])]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <Link
      to={`/plan/sessions/${session.id}`}
      aria-label={label}
      className="-mx-2 flex flex-col gap-1 rounded-sm px-2 active:bg-surface-2"
    >
      <span
        className={cn(
          "flex items-center justify-between gap-4 text-body",
          skipped ? "text-ink-2" : "text-ink",
        )}
      >
        <SessionTypeChip type={session.type} name={name} />
        <span className="flex shrink-0 gap-3">
          {skipped ? <span>{planWeekCopy.skipped}</span> : null}
          {distance ? <span>{distance}</span> : null}
          {duration ? <span>{duration}</span> : null}
        </span>
      </span>
      {steps ? <span className="text-body text-ink-2">{steps}</span> : null}
    </Link>
  );
}
