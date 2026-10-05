import type { Activity, Units } from "@running-coach/shared";
import type { ReactNode } from "react";
import { isApiError } from "@/api/client";
import { HrZonesChart } from "@/charts/hr-zones-chart";
import { toLapPoint } from "@/charts/lap-point";
import { SeriesChart } from "@/charts/series-chart";
import { toSeriesPoints } from "@/charts/series-point";
import { SplitBars } from "@/charts/split-bars";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorMessage, isVersionMismatch } from "@/lib/errors";
import type { DetailState } from "../use-run";
import { RouteSection } from "./route-section";
import { Note, RunSection } from "./run-section";
import { SplitsTable } from "./splits-table";

type RunDetailProps = {
  state: DetailState;
  activity: Activity;
  units: Units;
  onRetry: () => void;
};

/**
 * Everything Garmin holds beyond the summary, each part on its own card: route, splits (pace bars, or the
 * lap table on Show table), HR zones, cadence and elevation.
 * It has its own loading and error states, because the first open fetches it from Garmin (about 5 s) and
 * that fetch can fail while the stats above stay good.
 */
export function RunDetail({ state, activity, units, onRetry }: RunDetailProps) {
  if (state.status === "pending") {
    return <DetailSkeleton indoor={activity.isIndoor} />;
  }

  if (state.status === "error") {
    // A run deleted on Garmin Connect answers 404 every time: Retry would only ask again. Asking again for a
    // detail this version cannot read only answers the one the API stored, so that gets Reload instead.
    const gone = isApiError(state.error) && state.error.status === 404;
    return (
      <div className="flex flex-col items-start gap-4 border-t border-line pt-4">
        <p role="alert" className="text-body text-ink">
          {errorMessage(state.error)}
        </p>
        {gone ? null : isVersionMismatch(state.error) ? (
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        ) : (
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const { laps, streams, route, hrZones } = state.detail;

  return (
    <div className="mt-2 flex flex-col gap-6">
      <RouteSection isIndoor={activity.isIndoor} route={route} />
      <RunSection title="Splits">
        <SplitBars
          laps={laps.map((lap) => toLapPoint(lap, units))}
          unit={units}
          table={(count) => <SplitsTable laps={laps.slice(0, count)} units={units} />}
        />
      </RunSection>
      <RunSection title="Heart rate zones">
        {hrZones === null ? (
          <Note>No heart rate recorded, so no zones.</Note>
        ) : (
          <HrZonesChart zones={hrZones} />
        )}
      </RunSection>
      <RunSection title="Cadence">
        {streams.cadence === null ? (
          <Note>No cadence recorded.</Note>
        ) : (
          <SeriesChart
            points={toSeriesPoints(streams, units, "cadence")}
            unit={units}
            kind="cadence"
          />
        )}
      </RunSection>
      <RunSection title="Elevation">
        {streams.elevationM === null ? (
          <Note>No elevation recorded.</Note>
        ) : (
          <SeriesChart
            points={toSeriesPoints(streams, units, "elevation")}
            unit={units}
            kind="elevation"
          />
        )}
      </RunSection>
    </div>
  );
}

// Bar lengths for the skeleton's splits, so the rows read as pace bars before the laps arrive.
const SKELETON_BARS = ["w-11/12", "w-full", "w-5/6", "w-11/12"] as const;

/** The route and splits cards at their loaded heights, so nothing jumps when the detail arrives. */
function DetailSkeleton({ indoor }: { indoor: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading laps, route and zones"
      className="mt-2 flex flex-col gap-6"
    >
      <p className="text-caption text-ink-2">Getting laps, route and zones from Garmin.</p>
      {indoor ? null : (
        <SkeletonCard>
          <div className="h-60 rounded-md bg-surface-2" />
        </SkeletonCard>
      )}
      <SkeletonCard>
        <div className="flex flex-col">
          {SKELETON_BARS.map((width, row) => (
            <div key={row} className="flex h-11 items-center gap-2">
              <div className="w-10 shrink-0">
                <div className="h-4 w-6 rounded-sm bg-surface-2" />
              </div>
              <div className="min-w-0 flex-1">
                <div className={cn("h-9 rounded-sm bg-surface-2", width)} />
              </div>
              <div className="w-14 shrink-0" />
            </div>
          ))}
        </div>
      </SkeletonCard>
    </div>
  );
}

/** A section's heading and card as blocks. */
function SkeletonCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="h-5.5 w-16 rounded-sm bg-surface-2" />
      <div className="rounded-md bg-surface-1 p-4">{children}</div>
    </div>
  );
}
