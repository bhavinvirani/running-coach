import type { Activity, Units } from "@running-coach/shared";
import { isApiError } from "@/api/client";
import { HrZonesChart } from "@/charts/hr-zones-chart";
import { toLapPoint } from "@/charts/lap-point";
import { LapsChart } from "@/charts/laps-chart";
import { SeriesChart } from "@/charts/series-chart";
import { toSeriesPoints } from "@/charts/series-point";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
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
 * Everything Garmin holds beyond the summary: route, splits (lap pace chart over the lap table), HR zones,
 * cadence and elevation.
 * It has its own loading and error states, because the first open fetches it from Garmin (about 5 s) and
 * that fetch can fail while the stats above stay good.
 */
export function RunDetail({ state, activity, units, onRetry }: RunDetailProps) {
  if (state.status === "pending") {
    return <DetailSkeleton indoor={activity.isIndoor} />;
  }

  if (state.status === "error") {
    // A run deleted on Garmin Connect answers 404 every time: Retry would only ask again.
    const gone = isApiError(state.error) && state.error.status === 404;
    return (
      <div className="flex flex-col items-start gap-4 border-t border-line pt-4">
        <p role="alert" className="text-body text-ink">
          {errorMessage(state.error)}
        </p>
        {gone ? null : (
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const { laps, streams, route, hrZones } = state.detail;

  return (
    <>
      <RouteSection isIndoor={activity.isIndoor} route={route} />
      <RunSection title="Splits">
        {/* The table below is the chart's table view, so the chart has no toggle of its own. */}
        {laps.length > 0 ? (
          <LapsChart
            laps={laps.map((lap) => toLapPoint(lap, units))}
            unit={units}
            tableToggle={false}
          />
        ) : null}
        <SplitsTable laps={laps} units={units} />
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
    </>
  );
}

/** The route, lap pace and splits at their loaded heights, so nothing jumps when the detail arrives. */
function DetailSkeleton({ indoor }: { indoor: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading laps, route and zones"
      className="flex flex-col gap-4 border-t border-line pt-4"
    >
      <p className="text-caption text-ink-2">Getting laps, route and zones from Garmin.</p>
      {indoor ? null : <div className="h-60 rounded-md bg-surface-1" />}
      <div className="h-48 rounded-md bg-surface-1" />
      <div className="flex flex-col divide-y divide-line">
        {Array.from({ length: 4 }, (_, row) => (
          <div key={row} className="flex h-10 items-center justify-between">
            <div className="h-4 w-6 rounded-sm bg-surface-2" />
            <div className="h-4 w-40 rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
