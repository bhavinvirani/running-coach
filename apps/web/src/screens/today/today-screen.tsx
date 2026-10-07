import { ErrorCode } from "@running-coach/shared";
import type { ReactNode } from "react";
import { NO_BESTS } from "@/api/personal-bests";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { errorCodeMessage, errorMessage } from "@/lib/errors";
import { LatestRun } from "./parts/latest-run";
import { NextSevenDays } from "./parts/next-seven-days";
import { ReconnectGarminLink } from "./parts/reconnect-garmin-link";
import { SyncNowButton } from "./parts/sync-now-button";
import { useTodayScreen } from "./use-today";

/**
 * Today tab: Sync now, or Reconnect Garmin once the login expired, the latest run, and with an active plan
 * the next 7 days, where their workouts stand on Garmin, and Not feeling 100% to pause training (or the
 * open pause with I'm back). Empty until the first sync stores a run; the next 7 days show below the
 * empty state too, since a plan can start before any run is stored.
 */
export function TodayScreen() {
  const screen = useTodayScreen();
  const { data, status, error, refetch, units } = screen;

  if (status === "pending" || units === undefined) {
    return <TodaySkeleton />;
  }

  if (status === "error") {
    return (
      <TodayLayout>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </TodayLayout>
    );
  }

  // Expired: Sync now would only fail again, so Reconnect Garmin and one line saying why take its place,
  // and any outcome of an earlier sync goes, Retry included.
  const expiredLine = screen.garminExpired ? (
    <p role="alert" className="text-body text-ink">
      {errorCodeMessage(ErrorCode.garminAuthExpired)}
    </p>
  ) : null;
  const action = screen.garminExpired ? (
    <ReconnectGarminLink />
  ) : (
    <SyncNowButton syncing={screen.syncing} onSync={screen.syncNow} />
  );
  // A sync that found nothing new says so, otherwise "it worked" looks like "nothing happened"; one that
  // removed runs Garmin no longer lists says so, since they just vanish from the screen.
  const syncOutcome = screen.garminExpired ? null : screen.syncError ? (
    <RetryAlert error={screen.syncError} onRetry={screen.syncNow} />
  ) : screen.syncOutcome ? (
    <p role="status" className="text-caption text-ink-2">
      {screen.syncOutcome}
    </p>
  ) : null;
  const refetchFailed = screen.refetchError ? (
    <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
  ) : null;
  const nextSevenDays =
    screen.today === undefined ? null : (
      <NextSevenDays
        calendar={screen.calendar}
        today={screen.today}
        units={units}
        send={screen.send}
        unschedule={screen.unschedule}
        pause={screen.pause}
      />
    );

  // Empty: the sentence carries the one action, so the header leaves it out.
  if (data === null) {
    return (
      <TodayLayout>
        {refetchFailed}
        <div className="flex flex-col items-start gap-4">
          {expiredLine ?? (
            <p className="text-body text-ink-2">
              Sync now to bring in your latest run from Garmin.
            </p>
          )}
          {action}
        </div>
        {syncOutcome}
        {nextSevenDays}
      </TodayLayout>
    );
  }

  return (
    <TodayLayout action={action}>
      {expiredLine}
      {syncOutcome}
      {refetchFailed}
      <LatestRun activity={data} units={units} bests={screen.runBests.get(data.id) ?? NO_BESTS} />
      {nextSevenDays}
    </TodayLayout>
  );
}

function TodayLayout({
  children,
  action,
  busy,
}: {
  children: ReactNode;
  action?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      {/* As tall as the button, so the title stays put whether or not the header holds Sync now. */}
      <header className="flex min-h-11 items-center justify-between gap-4">
        <h1 className="text-title text-ink">Today</h1>
        {action}
      </header>
      {children}
    </div>
  );
}

/** The loaded layout with blocks at each line's height, so nothing jumps when the run arrives. */
function TodaySkeleton() {
  return (
    <TodayLayout busy action={<div className="h-11 w-28 rounded-sm bg-surface-2" />}>
      <div
        role="status"
        aria-label="Loading the latest run"
        className="flex flex-col gap-4 border-t border-line pt-4"
      >
        <div className="flex h-5.5 items-center justify-between">
          <div className="h-4 w-20 rounded-sm bg-surface-2" />
          <div className="h-4 w-32 rounded-sm bg-surface-2" />
        </div>
        <div className="flex flex-col gap-1">
          <div className="h-4 w-14 rounded-sm bg-surface-2" />
          <div className="h-12 w-36 rounded-sm bg-surface-2" />
        </div>
        <div className="flex flex-wrap justify-between gap-4 border-t border-line pt-4">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1">
              <div className="h-4 w-12 rounded-sm bg-surface-2" />
              <div className="h-8.5 w-18 rounded-sm bg-surface-2" />
            </div>
          ))}
        </div>
      </div>
    </TodayLayout>
  );
}
