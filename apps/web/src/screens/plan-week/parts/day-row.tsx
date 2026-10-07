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
import { adjustmentLine } from "@/lib/session-adjustment";
import { sessionTypeName } from "@/lib/session-type";
import { sessionName } from "@/lib/workout-steps";
import { planWeekCopy, sessionStateWord } from "../plan-week-copy";

type DayRowProps = {
  day: PlanDay;
  paces: PlanPaces;
  units: Units;
  /** Whether the day takes a workout of the runner's own: from today on, and not in an open pause. */
  addable: boolean;
};

/**
 * One day of the week: its date, with Add when the day takes one, then each session as its type chip with
 * distance and time on the right and its steps in one line under it (a lone run's pace band, so the
 * distance is not said twice), paces in the runner's unit. A custom workout with a title leads with it,
 * and its type's name starts the line under it. Each session opens its own screen. A day without a session
 * reads Rest; a skipped session reads Skipped, with nothing left to run, or only who skipped it when the
 * coach or a pause did; a done, missed or paused one says so beside its distance; a session the coach or a
 * return changed says what it was on a last line.
 */
export function DayRow({ day, paces, units, addable }: DayRowProps) {
  const label = formatLocalDay(day.date);
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex items-center justify-between gap-4">
        <time dateTime={day.date} className="text-caption text-ink-2">
          {label}
        </time>
        {addable ? (
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
  // A title takes the type's name off the first line, and the dot's color alone does not say the type.
  const type = session.title === null ? null : sessionTypeName(session.type);
  const state = sessionStateWord(session);
  const adjustment = adjustmentLine(session, units);
  const label = [name, type, day, state, distance, duration, adjustment]
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
          {state ? <span>{state}</span> : null}
          {distance ? <span>{distance}</span> : null}
          {duration ? <span>{duration}</span> : null}
        </span>
      </span>
      {type !== null || steps ? (
        <span className="text-body text-ink-2">
          {type}
          {type !== null && steps ? <span aria-hidden="true"> · </span> : null}
          {steps}
        </span>
      ) : null}
      {adjustment === null ? null : <span className="text-caption text-ink-2">{adjustment}</span>}
    </Link>
  );
}
