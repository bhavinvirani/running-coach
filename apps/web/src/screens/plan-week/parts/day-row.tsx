import {
  distanceInUnits,
  type PlanPaces,
  type PlanSession,
  type Units,
} from "@running-coach/shared";
import { SessionTypeChip } from "@/components/session-type-chip";
import { describeSteps } from "@/lib/describe-steps";
import { formatDistance, formatDuration, formatLocalDay } from "@/lib/format";
import type { PlanDay } from "@/lib/plan-week";

type DayRowProps = {
  day: PlanDay;
  paces: PlanPaces;
  units: Units;
};

/**
 * One day of the week: its date, then each session as its type chip with distance and time on the right
 * and its steps in one line under it, paces in the runner's unit. A day without a session reads Rest.
 */
export function DayRow({ day, paces, units }: DayRowProps) {
  return (
    <li className="flex flex-col gap-1 py-3">
      <time dateTime={day.date} className="text-caption text-ink-2">
        {formatLocalDay(day.date)}
      </time>
      {day.sessions.length === 0 ? (
        <p className="text-body text-ink">
          <SessionTypeChip type="rest" />
        </p>
      ) : (
        day.sessions.map((session) => (
          <SessionLines key={session.id} session={session} paces={paces} units={units} />
        ))
      )}
    </li>
  );
}

function SessionLines({
  session,
  paces,
  units,
}: {
  session: PlanSession;
  paces: PlanPaces;
  units: Units;
}) {
  const { distanceM, durationS } = session.target;
  const steps = describeSteps(session.steps, paces, units);

  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center justify-between gap-4 text-body text-ink">
        <SessionTypeChip type={session.type} />
        <span className="flex shrink-0 gap-3">
          {distanceM > 0 ? (
            <span>{formatDistance(distanceInUnits(distanceM, units), units)}</span>
          ) : null}
          {durationS > 0 ? <span>{formatDuration(durationS)}</span> : null}
        </span>
      </p>
      {steps ? <p className="text-body text-ink-2">{steps}</p> : null}
    </div>
  );
}
