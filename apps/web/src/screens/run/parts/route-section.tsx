import type { RoutePoint } from "@running-coach/shared";
import { RouteMap } from "@/charts/route-map";
import { Note, RunSection } from "./run-section";

type RouteSectionProps = {
  isIndoor: boolean;
  route: readonly RoutePoint[] | null;
};

/**
 * Where the run went. Indoors there is nothing to draw, which the runner knows, so the note says why rather
 * than that something is missing; outdoors a missing track (GPS off, a manual entry) is said plainly.
 */
export function RouteSection({ isIndoor, route }: RouteSectionProps) {
  return (
    <RunSection title="Route">
      {isIndoor ? (
        <Note>Indoor run: no GPS route.</Note>
      ) : route === null || route.length < 2 ? (
        <Note>No GPS route recorded.</Note>
      ) : (
        <RouteMap route={route} />
      )}
    </RunSection>
  );
}
