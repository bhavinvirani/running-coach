import type { ReactNode } from "react";
import { useParams } from "react-router";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatLocalDay } from "@/lib/format";
import { BackLink } from "@/components/back-link";
import { BestEfforts } from "./parts/best-efforts";
import { CoachCard } from "./parts/coach-card";
import { currentBests } from "./parts/current-bests";
import { RunDetail } from "./parts/run-detail";
import { RunStats } from "./parts/run-stats";
import { useRunScreen } from "./use-run";

/**
 * One run at /runs/:id: its summary, the coach's review, its best efforts, then the route, laps, zones and
 * samples fetched from Garmin on the first open. Keyed by id, so moving to another run starts over instead of showing the last one's state.
 */
export function RunScreen() {
  const { id = "" } = useParams();
  return <RunView key={id} id={id} />;
}

/**
 * Loading, error and content only. No empty state: the API answers with a stored run or with 404, and a
 * stored run always has its summary stats.
 */
function RunView({ id }: { id: string }) {
  const screen = useRunScreen(id);
  const { data, status, error, refetch, units } = screen;

  if (status === "pending" || units === undefined) {
    return <RunSkeleton />;
  }

  if (status === "error") {
    return (
      <RunLayout title="Run">
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </RunLayout>
    );
  }

  const { activity, bestEfforts } = data;

  return (
    <RunLayout title={formatLocalDay(activity.startLocal)}>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <RunStats activity={activity} units={units} bests={currentBests(bestEfforts)} />
      <CoachCard {...screen.coach} />
      <BestEfforts efforts={bestEfforts} units={units} />
      <RunDetail
        state={screen.detail}
        activity={activity}
        units={units}
        onRetry={screen.retryDetail}
      />
    </RunLayout>
  );
}

/** A detail screen: Back top left, the run's local day centered as the title. */
function RunLayout({
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
        <BackLink to="/progress" />
        {title === null ? (
          <div className="h-5 w-24 rounded-sm bg-surface-2" />
        ) : (
          <h1 className="text-title text-ink">{title}</h1>
        )}
      </header>
      {children}
    </div>
  );
}

/** The time line and the seven stats at their loaded heights, then a card where the detail goes. */
function RunSkeleton() {
  return (
    <RunLayout title={null} busy>
      <div role="status" aria-label="Loading the run" className="flex flex-col gap-4">
        <div className="h-4 w-12 rounded-sm bg-surface-2" />
        <div className="grid grid-cols-2 gap-x-4 gap-y-5">
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1">
              <div className="h-4 w-16 rounded-sm bg-surface-2" />
              <div className="h-8.5 w-24 rounded-sm bg-surface-2" />
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-col gap-2">
          <div className="h-5.5 w-16 rounded-sm bg-surface-2" />
          <div className="h-60 rounded-md bg-surface-1" />
        </div>
      </div>
    </RunLayout>
  );
}
