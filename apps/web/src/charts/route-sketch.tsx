import type { RoutePoint } from "@running-coach/shared";
import { projectRoute } from "./route-projection";

type RouteSketchProps = {
  route: readonly RoutePoint[];
  /** Why there is no map, one sentence: "Route only: no map token." */
  caption: string;
};

// The box at phone width; on a wider screen the drawing keeps its aspect and centers.
const BOX = { width: 358, height: 240, padding: 20 } as const;

/**
 * The route's shape without map tiles: what CI, unit tests and screenshots show, and the fallback when
 * Mapbox cannot load. The stroke stays 2 px at any size.
 */
export function RouteSketch({ route, caption }: RouteSketchProps) {
  const points = projectRoute(route, BOX)
    .map(([x, y]) => `${x},${y}`)
    .join(" ");

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Route sketch"
        className="h-60 w-full rounded-md bg-surface-1"
      >
        <polyline
          points={points}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="fill-none stroke-chart-series stroke-2"
        />
      </svg>
      <figcaption className="text-caption text-ink-2">{caption}</figcaption>
    </figure>
  );
}
