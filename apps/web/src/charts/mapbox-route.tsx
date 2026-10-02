// Loaded only through React.lazy in route-map.tsx when a Mapbox token is set, so mapbox-gl (about 1.7 MB)
// and its stylesheet stay out of the main bundle, unit tests and screenshots.
import type { RoutePoint } from "@running-coach/shared";
import "mapbox-gl/dist/mapbox-gl.css";
import { useMemo, useRef, useState } from "react";
import MapGL, { Layer, Source, type MapRef } from "react-map-gl/mapbox";
import { Button } from "@/components/ui/button";
import { routeBounds } from "./route-projection";

type MapboxRouteProps = {
  route: readonly RoutePoint[];
  token: string;
  /** The map could not start (bad token, offline): the caller draws the sketch instead. */
  onFail: (error: unknown) => void;
};

const FIT = { padding: 24, maxZoom: 16 } as const;

/** The route's color, read from the token at mount: Mapbox paints on a canvas and cannot use a CSS var. */
function seriesColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--color-chart-series").trim();
}

/**
 * The route on Mapbox's dark style, fitted to the run. No controls but Recenter; Mapbox's logo and
 * attribution stay because its terms require them. Two-finger panning (cooperative gestures) so a thumb
 * scrolling the page is never caught by the map.
 */
export function MapboxRoute({ route, token, onFail }: MapboxRouteProps) {
  const mapRef = useRef<MapRef>(null);
  const loaded = useRef(false);
  const [lineColor] = useState(seriesColor);
  const bounds = useMemo(() => routeBounds(route), [route]);
  const line = useMemo(
    () => ({
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "LineString" as const,
        coordinates: route.map(([lat, lng]) => [lng, lat]),
      },
    }),
    [route],
  );

  return (
    <div className="relative h-60 overflow-hidden rounded-md">
      <MapGL
        ref={mapRef}
        mapboxAccessToken={token}
        mapStyle="mapbox://styles/mapbox/dark-v11"
        initialViewState={{ bounds, fitBoundsOptions: FIT }}
        cooperativeGestures
        dragRotate={false}
        pitchWithRotate={false}
        touchPitch={false}
        onLoad={() => {
          loaded.current = true;
        }}
        // Errors after the style loaded are single tiles; the map still works without them.
        onError={(event) => {
          if (!loaded.current) onFail(event.error);
        }}
      >
        <Source id="route" type="geojson" data={line}>
          <Layer
            id="route-line"
            type="line"
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{ "line-color": lineColor, "line-width": 3 }}
          />
        </Source>
      </MapGL>
      <Button
        variant="ghost"
        className="absolute top-2 right-2 bg-surface-0"
        onClick={() => mapRef.current?.fitBounds(bounds, FIT)}
      >
        Recenter
      </Button>
    </div>
  );
}
