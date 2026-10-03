import { distanceInUnits } from "@running-coach/shared";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { BackLink } from "@/components/back-link";
import { DotLine } from "@/components/dot-line";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { MISSING, formatDistanceValue, formatWeekRange } from "@/lib/format";
import { phaseName, planDays, weekTitle } from "@/lib/plan-week";
import { DayRow } from "./parts/day-row";
import { planWeekCopy } from "./plan-week-copy";
import { usePlanWeekScreen } from "./use-plan-week";

/**
 * One week of the plan at /plan/weeks/:number: its distance and phase, then every day Monday to Sunday
 * with its sessions' steps, the runner's own workouts and skipped sessions included. Each session opens
 * its screen; days from today on take Add. Empty when the plan has no such week, or there is no plan.
 */
export function PlanWeekScreen() {
  const { number = "" } = useParams();
  const screen = usePlanWeekScreen();
  const { data, status, error, refetch, units, today } = screen;

  if (status === "pending" || units === undefined || today === undefined) {
    return <PlanWeekSkeleton />;
  }

  if (status === "error") {
    return (
      <PlanWeekLayout title={planWeekCopy.title}>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </PlanWeekLayout>
    );
  }

  const refetchFailed = screen.refetchError ? (
    <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
  ) : null;
  const plan = data.plan;
  const week = plan?.weeks.find((candidate) => String(candidate.number) === number);

  if (plan === null || week === undefined) {
    return (
      <PlanWeekLayout title={planWeekCopy.title}>
        {refetchFailed}
        <div className="flex flex-col items-start gap-4">
          <p className="text-body text-ink-2">
            {plan === null ? planWeekCopy.noPlan : planWeekCopy.noSuchWeek(number)}
          </p>
          <Button asChild>
            <Link to="/plan">{planWeekCopy.openPlan}</Link>
          </Button>
        </div>
      </PlanWeekLayout>
    );
  }

  const lastWeekStart = plan.weeks[plan.weeks.length - 1]?.startDate ?? plan.startDate;
  const distance =
    week.distanceM > 0 ? formatDistanceValue(distanceInUnits(week.distanceM, units)) : MISSING;

  return (
    <PlanWeekLayout title={weekTitle(week.number)}>
      {refetchFailed}
      <div className="flex flex-col items-center gap-1">
        <p className="text-figure text-ink">
          {distance}
          {distance === MISSING ? null : (
            <span className="ml-1 text-caption text-ink-2">{units}</span>
          )}
        </p>
        <DotLine className="text-caption text-ink-2">
          {phaseName(week.phase)}
          {formatWeekRange(week.startDate, lastWeekStart)}
        </DotLine>
      </div>
      <section aria-label={planWeekCopy.days} className="flex flex-col gap-2">
        <h2 className="text-body font-semibold text-ink">{planWeekCopy.days}</h2>
        <ol className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
          {planDays(week).map((day) => (
            <DayRow key={day.date} day={day} paces={plan.paces} units={units} today={today} />
          ))}
        </ol>
      </section>
    </PlanWeekLayout>
  );
}

/** A detail screen: Back top left, the week centered as the title. */
function PlanWeekLayout({
  title,
  children,
  busy,
}: {
  /** Null while loading: a block at the title's height. */
  title: string | null;
  children: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <header className="relative flex min-h-11 items-center justify-center">
        <BackLink to="/plan" />
        {title === null ? (
          <div className="h-5 w-20 rounded-sm bg-surface-2" />
        ) : (
          <h1 className="text-title text-ink">{title}</h1>
        )}
      </header>
      {children}
    </div>
  );
}

/** The figure, the phase line and seven days at their loaded heights. */
function PlanWeekSkeleton() {
  return (
    <PlanWeekLayout title={null} busy>
      <div role="status" aria-label={planWeekCopy.loading} className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-1">
          <div className="h-8.5 w-24 rounded-sm bg-surface-2" />
          <div className="flex h-4 items-center">
            <div className="h-3 w-28 rounded-sm bg-surface-2" />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex h-5.5 items-center">
            <div className="h-4 w-10 rounded-sm bg-surface-2" />
          </div>
          <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
            {Array.from({ length: 7 }, (_, position) => (
              <div key={position} className="flex flex-col gap-1 py-3">
                <div className="flex h-4 items-center">
                  <div className="h-3 w-16 rounded-sm bg-surface-2" />
                </div>
                <div className="flex h-5.5 items-center justify-between">
                  <div className="h-4 w-20 rounded-sm bg-surface-2" />
                  <div className="h-4 w-24 rounded-sm bg-surface-2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PlanWeekLayout>
  );
}
