import type { ReactNode } from "react";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatWeekRange } from "@/lib/format";
import { EarlierWeeks } from "./parts/earlier-weeks";
import { ImportStatus, StartImportError } from "./parts/import-status";
import { WeekSection } from "./parts/week-section";
import { WeekSkeleton } from "./parts/week-skeleton";
import { progressCopy } from "./progress-copy";
import { useProgressScreen } from "./use-progress";

/**
 * Progress tab: the history import's line, then runs by week, newest first. Empty until a sync or the
 * import stores a run.
 */
export function ProgressScreen() {
  const screen = useProgressScreen();
  const { data, status, error, refetch, settings } = screen;

  if (status === "pending" || settings === undefined) {
    return (
      <ProgressLayout busy>
        <ProgressSkeleton />
      </ProgressLayout>
    );
  }

  if (status === "error") {
    return (
      <ProgressLayout>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </ProgressLayout>
    );
  }

  // Waits for the import too, so its line never pops in above weeks already on screen.
  if (screen.importLoading) {
    return (
      <ProgressLayout busy>
        <ProgressSkeleton />
      </ProgressLayout>
    );
  }

  const backgroundError = screen.refetchError ?? screen.importError;
  const backgroundFailed = backgroundError ? (
    <RetryAlert error={backgroundError} onRetry={screen.retryBackground} />
  ) : null;
  const progress = screen.importProgress;
  const importStatus = progress ? (
    <ImportStatus
      progress={progress}
      timeZone={settings.timezone}
      starting={screen.starting}
      startError={screen.startError}
      onStart={screen.startImport}
    />
  ) : null;

  if (data.length === 0) {
    // Before any import the sentence carries the one Import history; once one ran, its line says where
    // it stands and holds whatever action that allows, so the sentence adds none.
    if (progress === undefined || progress.status === "not_started") {
      return (
        <ProgressLayout>
          {backgroundFailed}
          <div className="flex flex-col items-start gap-4">
            <p className="text-body text-ink-2">{progressCopy.empty}</p>
            <Button
              disabled={screen.starting}
              aria-busy={screen.starting}
              onClick={screen.startImport}
            >
              {progressCopy.importHistory}
            </Button>
            {screen.startError ? <StartImportError error={screen.startError} /> : null}
          </div>
        </ProgressLayout>
      );
    }
    return (
      <ProgressLayout>
        {backgroundFailed}
        {importStatus}
        <p className="border-t border-line pt-4 text-body text-ink-2">
          {progressCopy.emptyWithImport}
        </p>
      </ProgressLayout>
    );
  }

  const newestWeekStart = data[0]?.weekStart;
  const showEnd = screen.hasEarlierWeeks || screen.loadingEarlierWeeks || screen.earlierWeeksError;

  return (
    <ProgressLayout>
      {backgroundFailed}
      {importStatus}
      {data.map((week) => (
        <WeekSection
          key={week.weekStart}
          week={week}
          label={formatWeekRange(week.weekStart, newestWeekStart)}
          units={settings.units}
        />
      ))}
      {showEnd ? (
        <EarlierWeeks
          loading={screen.loadingEarlierWeeks}
          error={screen.earlierWeeksError}
          onShow={screen.showEarlierWeeks}
        />
      ) : null}
    </ProgressLayout>
  );
}

// Every branch renders ProgressLayout at the root, so React keeps the title in place when data arrives
// instead of remounting the whole screen.
function ProgressLayout({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <h1 className="text-title text-ink">{progressCopy.title}</h1>
      {children}
    </div>
  );
}

/** The import line and two weeks at their loaded heights, so nothing jumps when the runs arrive. */
function ProgressSkeleton() {
  return (
    <div role="status" aria-label={progressCopy.loading} className="flex flex-col gap-4">
      <div className="flex h-5.5 items-center">
        <div className="h-4 w-64 rounded-sm bg-surface-2" />
      </div>
      <WeekSkeleton />
      <WeekSkeleton />
    </div>
  );
}
