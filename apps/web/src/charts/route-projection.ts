import type { RoutePoint } from "@running-coach/shared";

export type SketchBox = { width: number; height: number; padding: number };

/**
 * The route as x, y pairs inside `box`, for an SVG polyline: equirectangular, with longitude shrunk by the
 * cosine of the mean latitude so a loop at 51°N is not drawn 1.6 times too wide, north up, the aspect kept
 * and the drawing centered. A route with no extent in one direction (a straight line, one repeated point)
 * is centered on that axis.
 */
export function projectRoute(route: readonly RoutePoint[], box: SketchBox): [number, number][] {
  if (route.length === 0) return [];
  const meanLat = route.reduce((sum, [lat]) => sum + lat, 0) / route.length;
  const shrink = Math.cos((meanLat * Math.PI) / 180);
  const projected = route.map(([lat, lng]): [number, number] => [lng * shrink, -lat]);

  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;

  const innerWidth = box.width - 2 * box.padding;
  const innerHeight = box.height - 2 * box.padding;
  const scales = [spanX > 0 ? innerWidth / spanX : null, spanY > 0 ? innerHeight / spanY : null];
  const scale = Math.min(...scales.filter((value) => value !== null), Number.POSITIVE_INFINITY);
  const finiteScale = Number.isFinite(scale) ? scale : 0;
  const offsetX = (box.width - spanX * finiteScale) / 2;
  const offsetY = (box.height - spanY * finiteScale) / 2;

  return projected.map(([x, y]) => [
    round(offsetX + (x - minX) * finiteScale),
    round(offsetY + (y - minY) * finiteScale),
  ]);
}

/** Two decimals: invisible on screen, and it keeps the SVG attribute short for 2000 points. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** [[west, south], [east, north]] for fitting a map to the route. */
export function routeBounds(route: readonly RoutePoint[]): [[number, number], [number, number]] {
  const lats = route.map(([lat]) => lat);
  const lngs = route.map(([, lng]) => lng);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}
