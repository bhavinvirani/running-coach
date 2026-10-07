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
import { adjustmentLine, isRestChange } from "@/lib/session-adjustment";
import { canAdd } from "@/lib/session-days";
import { sessionTypeName } from "@/lib/session-type";
import { sessionName } from "@/lib/workout-steps";
import { OtherGarminWorkouts, type UnscheduleState } from "./other-garmin-workouts";
import { NotFeelingButton, PauseNotice, PausePanel } from "./pause-training";
import { usePauseFlow, type PauseState } from "./use-pause-flow";

const TITLE = "Next 7 days";

type NextSevenDaysProps = {
  calendar: ScreenState<CalendarResponse>;
  /** The runner's local date. */
  today: string;
  units: Units;
  send: SendState;
  unschedule: UnscheduleState;
  pause: PauseState;
};

/**
 * The plan's coming week on Today: a row per day from today with its sessions, each opening its session
 * screen with its Garmin state or what happened to it and any change the coach or a return made, an Add
 * per day for a workout of the runner's own (none from an open pause's start, which the API refuses), and
 * the workouts on the Garmin calendar the app did not put there. Not feeling 100% beside the heading
 * pauses training, and while a pause is open its card sits above the week with I'm back. Shown only with an active plan (the calendar answers its paces); a runner without
 * one sees Today as before. The week waits for the pause as well as the calendar, so the paused card never
 * pushes a loaded week down.
 */
export function NextSevenDays(props: NextSevenDaysProps) {
  const { calendar } = props;
  if (calendar.status === "success" && calendar.data.paces === null) return null;
  return <PlanWeekAhead {...props} />;
}

function PlanWeekAhead({ calendar, today, units, send, unschedule, pause }: NextSevenDaysProps) {
  const flow = usePauseFlow(pause);
  const pending =
    calendar.status === "pending" ||
    (calendar.status === "success" && pause.state.status === "pending");
  const loaded = calendar.status === "success" && !pending;
  // A pause that failed to load leaves Add on every day: the API still refuses one dated in a pause.
  const pauseStart =
    pause.state.status === "success" ? (pause.state.data.pause?.startDate ?? null) : null;

  // Every branch renders the same tree at the root, so the section stays in place as the data arrives.
  return (
    <>
      {loaded ? <PauseNotice flow={flow} pause={pause} /> : null}
      <section aria-label={TITLE} aria-busy={pending} className="flex flex-col gap-2">
        {/* As tall as Not feeling 100%, so the heading stays put whether or not the button shows. */}
        <div className="flex min-h-11 items-center justify-between gap-4">
          <h2 className="text-body font-semibold text-ink">{TITLE}</h2>
          {loaded ? <NotFeelingButton flow={flow} /> : null}
        </div>
        {flow.choosing ? <PausePanel flow={flow} pause={pause} /> : null}
        {/* The status spelt out beside pending, so the branches below narrow the calendar. */}
        {calendar.status === "pending" || pending ? (
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
                  addable={canAdd(day.date, today, pauseStart)}
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

type DayRowProps = {
  day: CalendarDay;
  today: string;
  /** Whether the day takes Add: not in an open pause. */
  addable: boolean;
  units: Units;
  garmin: GarminPushStatus;
};

/**
 * One day: "Today", "Tomorrow" or "Thu 8" on the left, its sessions in the middle, Add on the right when
 * the day takes one. Each column's first line is 44 px high, the tap target, so they line up however many
 * sessions the day has.
 */
function DayRow({ day, today, addable, units, garmin }: DayRowProps) {
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
              // A rest the coach or a pause made says it was skipped; the caption would say it twice.
              caption={isRestChange(session) ? null : garminCaption(session, garmin, today)}
              adjustment={adjustmentLine(session, units)}
            />
          ))
        )}
      </div>
      {addable ? (
        <Link
          to={`/plan/sessions/new?date=${day.date}`}
          aria-label={`Add a workout on ${formatLocalDay(day.date)}`}
          className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-sm text-body font-semibold text-ink active:bg-surface-2"
        >
          Add
        </Link>
      ) : null}
    </li>
  );
}

/**
 * A session as its name, then its type when a title took the name's place (the dot's color alone does not
 * say it), distance and time, then where it stands on Garmin or what happened to it (Done, Missed, Paused)
 * on a line of its own, so no row wraps a caption under its time at 390 px and every row reads the same
 * way, and last what it was before the coach or a return changed it.
 */
function SessionLink({
  session,
  units,
  caption,
  adjustment,
}: {
  session: PlanSession;
  units: Units;
  caption: string | null;
  adjustment: string | null;
}) {
  const skipped = session.status === "skipped";
  const { distanceM, durationS } = session.target;
  const distance =
    !skipped && distanceM > 0 ? formatDistance(distanceInUnits(distanceM, units), units) : null;
  const duration = !skipped && durationS > 0 ? formatDuration(durationS) : null;
  const name = sessionName(session);
  const type = session.title === null ? null : sessionTypeName(session.type);
  const facts = [type, distance, duration].filter((part) => part !== null);
  // Named in words: read from the lines, a screen reader would run "11.6 km" into "1:04:00".
  const label = [name, ...facts, caption, adjustment].filter((part) => part !== null).join(", ");

  return (
    <Link
      to={`/plan/sessions/${session.id}`}
      aria-label={label}
      className="-mx-2 flex min-h-11 flex-col justify-center rounded-sm px-2 py-1 active:bg-surface-2"
    >
      <span className={cn("text-body", skipped ? "text-ink-2" : "text-ink")}>
        <SessionTypeChip type={session.type} name={name} />
      </span>
      {facts.length > 0 ? (
        <DotLine className="text-caption text-ink-2">
          {type}
          {distance}
          {duration}
        </DotLine>
      ) : null}
      {caption === null ? null : <span className="text-caption text-ink-2">{caption}</span>}
      {adjustment === null ? null : <span className="text-caption text-ink-2">{adjustment}</span>}
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
