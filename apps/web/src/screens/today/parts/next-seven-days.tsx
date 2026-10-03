import {
  distanceInUnits,
  type CalendarDay,
  type CalendarResponse,
  type GarminPushStatus,
  type PlanSession,
  type Units,
} from "@running-coach/shared";
import { Link } from "react-router";
import type { ScreenState } from "@/api/screen-state";
import { DotLine } from "@/components/dot-line";
import { GarminPushLine, type SendState } from "@/components/garmin-push-line";
import { RetryAlert } from "@/components/retry-alert";
import { SessionTypeChip } from "@/components/session-type-chip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { garminCaption } from "@/lib/garmin-state";
import { formatDistance, formatDuration, formatLocalDay, formatUpcomingDay } from "@/lib/format";
import { sessionName } from "@/lib/workout-steps";
import { OtherGarminWorkouts, type UnscheduleState } from "./other-garmin-workouts";

const TITLE = "Next 7 days";

type NextSevenDaysProps = {
  calendar: ScreenState<CalendarResponse>;
  /** The runner's local date. */
  today: string;
  units: Units;
  send: SendState;
  unschedule: UnscheduleState;
};

/**
 * The plan's coming week on Today: a row per day from today with its sessions, each opening its session
 * screen with its Garmin state, an Add per day for a workout of the runner's own, and the workouts on the
 * Garmin calendar the app did not put there. Shown only with an active plan (the calendar answers its
 * paces); a runner without one sees Today as before.
 */
export function NextSevenDays({ calendar, today, units, send, unschedule }: NextSevenDaysProps) {
  if (calendar.status === "success" && calendar.data.paces === null) return null;

  // Every branch renders the same tree at the root, so the section stays in place as the data arrives.
  return (
    <>
      <section
        aria-label={TITLE}
        aria-busy={calendar.status === "pending"}
        className="flex flex-col gap-2"
      >
        <h2 className="text-body font-semibold text-ink">{TITLE}</h2>
        {calendar.status === "pending" ? (
          <NextSevenDaysSkeleton />
        ) : calendar.status === "error" ? (
          <div className="flex flex-col items-start gap-4">
            <p role="alert" className="text-body text-ink">
              {errorMessage(calendar.error)}
            </p>
            <Button variant="secondary" onClick={() => void calendar.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {calendar.refetchError ? (
              <RetryAlert error={calendar.refetchError} onRetry={() => void calendar.refetch()} />
            ) : null}
            <GarminPushLine garmin={calendar.data.garmin} send={send} />
            <ol className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
              {calendar.data.days.map((day) => (
                <DayRow
                  key={day.date}
                  day={day}
                  today={today}
                  units={units}
                  // A send in flight reads Sending at once, as the push line does.
                  garmin={{
                    ...calendar.data.garmin,
                    pushing: calendar.data.garmin.pushing || send.sending,
                  }}
                />
              ))}
            </ol>
          </>
        )}
      </section>
      {calendar.status === "success" ? (
        <OtherGarminWorkouts others={calendar.data.garmin.others} unschedule={unschedule} />
      ) : null}
    </>
  );
}

type DayRowProps = { day: CalendarDay; today: string; units: Units; garmin: GarminPushStatus };

/**
 * One day: "Today", "Tomorrow" or "Thu 8" on the left, its sessions in the middle, Add on the right. Each
 * column's first line is 44 px high, the tap target, so they line up however many sessions the day has.
 */
function DayRow({ day, today, units, garmin }: DayRowProps) {
  return (
    <li className="flex items-start gap-3 py-1">
      <time
        dateTime={day.date}
        className="flex h-11 w-16 shrink-0 items-center text-caption text-ink-2"
      >
        {formatUpcomingDay(day.date, today)}
      </time>
      <div className="flex min-w-0 flex-1 flex-col">
        {day.sessions.length === 0 ? (
          <p className="flex h-11 items-center text-body text-ink-2">
            <SessionTypeChip type="rest" />
          </p>
        ) : (
          day.sessions.map((session) => (
            <SessionLink
              key={session.id}
              session={session}
              units={units}
              caption={garminCaption(session, garmin, today)}
            />
          ))
        )}
      </div>
      <Link
        to={`/plan/sessions/new?date=${day.date}`}
        aria-label={`Add a workout on ${formatLocalDay(day.date)}`}
        className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-sm text-body font-semibold text-ink active:bg-surface-2"
      >
        Add
      </Link>
    </li>
  );
}

function SessionLink({
  session,
  units,
  caption,
}: {
  session: PlanSession;
  units: Units;
  caption: string | null;
}) {
  const skipped = session.status === "skipped";
  const { distanceM, durationS } = session.target;
  const distance =
    !skipped && distanceM > 0 ? formatDistance(distanceInUnits(distanceM, units), units) : null;
  const duration = !skipped && durationS > 0 ? formatDuration(durationS) : null;
  const name = sessionName(session);
  // Named in words: read from the lines, a screen reader would run "11.6 km" into "1:04:00".
  const label = [name, distance, duration, caption].filter((part) => part !== null).join(", ");

  return (
    <Link
      to={`/plan/sessions/${session.id}`}
      aria-label={label}
      className="-mx-2 flex min-h-11 flex-col justify-center rounded-sm px-2 py-1 active:bg-surface-2"
    >
      <span className={cn("text-body", skipped ? "text-ink-2" : "text-ink")}>
        <SessionTypeChip type={session.type} name={name} />
      </span>
      <DotLine className="text-caption text-ink-2">
        {distance}
        {duration}
        {caption}
      </DotLine>
    </Link>
  );
}

/** The push line and seven rows at their loaded heights, so nothing jumps on load. */
function NextSevenDaysSkeleton() {
  return (
    <div role="status" aria-label="Loading the next 7 days" className="flex flex-col gap-2">
      <div className="h-11 w-36 rounded-sm bg-surface-2" />
      <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {Array.from({ length: 7 }, (_, position) => (
          <div key={position} className="flex items-center gap-3 py-1">
            <div className="flex h-11 w-16 items-center">
              <div className="h-3 w-12 rounded-sm bg-surface-2" />
            </div>
            <div className="h-4 flex-1 rounded-sm bg-surface-2" />
            <div className="h-4 w-8 rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
