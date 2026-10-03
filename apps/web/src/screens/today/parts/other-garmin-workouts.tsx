import type { OtherGarminWorkout } from "@running-coach/shared";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatLocalDay } from "@/lib/format";

const TITLE = "Also on your Garmin calendar";
const UNTITLED = "Untitled workout";

export type UnscheduleState = {
  /** The workout being taken off now; every Unschedule waits for it, so one tap never hides another's. */
  pendingId: number | null;
  /** Why each workout failed to come off, by schedule id, until it is tried again. */
  failures: ReadonlyMap<number, Error>;
  onUnschedule: (scheduleId: number) => void;
};

type OtherGarminWorkoutsProps = {
  others: readonly OtherGarminWorkout[];
  unschedule: UnscheduleState;
};

/**
 * Workouts on the runner's Garmin calendar this week that the app did not put there (a coach's, an old
 * plan's), so two workouts on one day can be cleared up from here. Unschedule takes one off the calendar
 * and leaves the workout in the runner's Garmin library, one at a time. Nothing shows when there are none.
 */
export function OtherGarminWorkouts({ others, unschedule }: OtherGarminWorkoutsProps) {
  if (others.length === 0) return null;

  return (
    <section aria-label={TITLE} className="flex flex-col gap-2">
      <h2 className="text-body font-semibold text-ink">{TITLE}</h2>
      <ul className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {others.map((workout) => {
          const title = workout.title ?? UNTITLED;
          const day = formatLocalDay(workout.date);
          const pending = unschedule.pendingId === workout.scheduleId;
          const failed = unschedule.failures.get(workout.scheduleId) ?? null;
          return (
            <li key={workout.scheduleId} className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-body text-ink">{title}</span>
                  <time dateTime={workout.date} className="text-caption text-ink-2">
                    {day}
                  </time>
                </div>
                <Button
                  variant="secondary"
                  aria-label={`Unschedule ${title} on ${day}`}
                  disabled={unschedule.pendingId !== null}
                  aria-busy={pending}
                  onClick={() => unschedule.onUnschedule(workout.scheduleId)}
                >
                  {pending ? "Unscheduling…" : "Unschedule"}
                </Button>
              </div>
              {failed ? (
                <p role="alert" className="text-body text-ink">
                  {errorMessage(failed)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
