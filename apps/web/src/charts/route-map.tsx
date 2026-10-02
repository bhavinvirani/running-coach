import type { RoutePoint } from "@running-coach/shared";
import { Component, Suspense, lazy, useState, type ReactNode } from "react";
import { RouteSketch } from "./route-sketch";

type RouteMapProps = {
  /** At least two points; RouteSection says why there is no route otherwise. */
  route: readonly RoutePoint[];
};

const MapboxRoute = lazy(async () => ({
  default: (await import("./mapbox-route")).MapboxRoute,
}));

export const noTokenCaption = "Route only: no map token.";
export const mapFailedCaption = "Route only: the map did not load.";

/**
 * The run's route on a Mapbox map when the build has a token, otherwise (dev without a token, CI, tests,
 * screenshots) as a sketch. mapbox-gl loads only in the first case. A map that fails to load or start
 * (offline, a revoked token, no WebGL) falls back to the sketch rather than taking the screen down.
 */
export function RouteMap({ route }: RouteMapProps) {
  const token = import.meta.env.VITE_MAPBOX_TOKEN ?? "";
  const [failed, setFailed] = useState(false);

  if (token === "") return <RouteSketch route={route} caption={noTokenCaption} />;
  const sketch = <RouteSketch route={route} caption={mapFailedCaption} />;
  if (failed) return sketch;

  return (
    <MapBoundary fallback={sketch}>
      <Suspense
        fallback={
          <div
            role="status"
            aria-label="Loading the map"
            className="h-60 rounded-md bg-surface-1"
          />
        }
      >
        <MapboxRoute
          route={route}
          token={token}
          onFail={(error) => {
            console.error(error);
            setFailed(true);
          }}
        />
      </Suspense>
    </MapBoundary>
  );
}

type MapBoundaryProps = { fallback: ReactNode; children: ReactNode };

/** Catches a map chunk that fails to download or a Mapbox constructor that throws. */
class MapBoundary extends Component<MapBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
