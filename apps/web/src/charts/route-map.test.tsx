import type { RoutePoint } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouteMap, mapFailedCaption, noTokenCaption } from "./route-map";
import { projectRoute, routeBounds } from "./route-projection";

// The real module would load mapbox-gl, which needs WebGL; the token path is tested against this stand-in.
const mapbox = vi.hoisted(() => ({ fail: null as Error | null, failOnLoad: false }));
vi.mock("./mapbox-route", () => ({
  MapboxRoute: ({
    route,
    token,
    onFail,
  }: {
    route: readonly RoutePoint[];
    token: string;
    onFail: (error: unknown) => void;
  }) => {
    if (mapbox.fail) throw mapbox.fail;
    if (mapbox.failOnLoad) queueMicrotask(() => onFail(new Error("style 401")));
    return (
      <p>
        Mapbox map of {route.length} points with {token}
      </p>
    );
  },
}));

/**
 * A fictional square of 0.01° at 60°N, where a degree of longitude is half a degree of latitude, in the
 * North Atlantic: fixtures hold no real place (tests rule).
 */
const square: RoutePoint[] = [
  [60, -30],
  [60, -29.99],
  [60.01, -29.99],
  [60.01, -30],
  [60, -30],
];

const box = { width: 300, height: 200, padding: 10 };

describe("projectRoute", () => {
  it("shrinks longitude by the cosine of the latitude and keeps the aspect, centered", () => {
    const points = projectRoute(square, box);
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    // cos 60.005° ≈ 0.4999: the square is about half as wide as tall, filling the 180 px inner height.
    expect(height).toBeCloseTo(180, 0);
    expect(width / height).toBeCloseTo(0.5, 2);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(150, 1);
  });

  it("draws north up", () => {
    const [start, east, northEast] = projectRoute(square, box);
    expect(east?.[0]).toBeGreaterThan(start?.[0] ?? 0);
    expect(northEast?.[1]).toBeLessThan(east?.[1] ?? 0);
  });

  it("centers a route with no extent, one repeated point, instead of dividing by zero", () => {
    const points = projectRoute(
      [
        [0, -30],
        [0, -30],
      ],
      box,
    );
    expect(points).toEqual([
      [150, 100],
      [150, 100],
    ]);
  });

  it("returns the route's west-south and east-north corners for fitting a map", () => {
    expect(routeBounds(square)).toEqual([
      [-30, 60],
      [-29.99, 60.01],
    ]);
  });
});

describe("RouteMap", () => {
  it("draws the route as a sketch with a caption when the build has no map token", () => {
    const { container } = render(<RouteMap route={square} />);
    expect(screen.getByRole("img", { name: "Route sketch" })).toBeInTheDocument();
    const line = container.querySelector("polyline");
    expect(line?.getAttribute("points")?.split(" ")).toHaveLength(5);
    expect(line).toHaveClass("stroke-chart-series", "stroke-2", "fill-none");
    expect(screen.getByText(noTokenCaption)).toHaveClass("text-caption", "text-ink-2");
    expect(screen.queryByText(/Mapbox map/)).not.toBeInTheDocument();
  });

  it("loads the Mapbox map with the token when the build has one", async () => {
    vi.stubEnv("VITE_MAPBOX_TOKEN", "pk.test-token");
    mapbox.fail = null;
    mapbox.failOnLoad = false;
    render(<RouteMap route={square} />);
    expect(
      await screen.findByText("Mapbox map of 5 points with pk.test-token"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Route sketch" })).not.toBeInTheDocument();
  });

  it("falls back to the sketch when Mapbox throws while starting (no WebGL)", async () => {
    vi.stubEnv("VITE_MAPBOX_TOKEN", "pk.test-token");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mapbox.fail = new Error("WebGL is not supported");
    mapbox.failOnLoad = false;
    render(<RouteMap route={square} />);
    expect(await screen.findByText(mapFailedCaption)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Route sketch" })).toBeInTheDocument();
  });

  it("falls back to the sketch when the map style fails to load (revoked token, offline)", async () => {
    vi.stubEnv("VITE_MAPBOX_TOKEN", "pk.test-token");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mapbox.fail = null;
    mapbox.failOnLoad = true;
    render(<RouteMap route={square} />);
    expect(await screen.findByText(mapFailedCaption)).toBeInTheDocument();
    expect(screen.queryByText(/Mapbox map/)).not.toBeInTheDocument();
  });
});
