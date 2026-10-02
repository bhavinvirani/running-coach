import type { ActivityStreams } from "@running-coach/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeriesChart } from "./series-chart";
import { seriesStretches, toSeriesPoints, type SeriesPoint } from "./series-point";

/** Row-aligned samples like the API's, every 100 m; series default to recorded. */
function streams(overrides: Partial<ActivityStreams> = {}, rows = 31): ActivityStreams {
  const index = Array.from({ length: rows }, (_, row) => row);
  return {
    elapsedS: index.map((row) => row * 30),
    distanceM: index.map((row) => row * 100),
    hr: index.map(() => 150),
    cadence: index.map((row) => 170 + (row % 4)),
    elevationM: index.map((row) => 20 + row),
    speedMps: index.map(() => 3.3),
    ...overrides,
  };
}

/** Axis labels as drawn; Recharts puts each word in its own tspan, so "3.0 km" reads "3.0km". */
function ticks(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".recharts-cartesian-axis-tick-value")].map(
    (tick) => tick.textContent ?? "",
  );
}

/** The points the line draws, from its SVG path: one M or L command each. */
function linePoints(container: HTMLElement): number {
  const path = container.querySelector(".recharts-line-curve")?.getAttribute("d") ?? "";
  return path.match(/[ML]/g)?.length ?? 0;
}

describe("toSeriesPoints", () => {
  it("pairs each cadence sample with its distance in km or mi", () => {
    const points = toSeriesPoints(streams({}, 3), "km", "cadence");
    expect(points).toEqual([
      { distanceInUnit: 0, value: 170 },
      { distanceInUnit: 0.1, value: 171 },
      { distanceInUnit: 0.2, value: 172 },
    ]);
    const miles = toSeriesPoints(
      streams({ distanceM: [0, 1609.344, 3218.688] }, 3),
      "mi",
      "cadence",
    );
    expect(miles.map((point) => point.distanceInUnit)).toEqual([0, 1, 2]);
  });

  it("keeps elevation in meters with km and converts it to feet with mi (unit conversion)", () => {
    const series = streams({ elevationM: [0, 30.48, -3.048] }, 3);
    expect(toSeriesPoints(series, "km", "elevation").map((point) => point.value)).toEqual([
      0, 30.48, -3.048,
    ]);
    const feet = toSeriesPoints(series, "mi", "elevation").map((point) => point.value);
    expect(feet[1]).toBeCloseTo(100);
    expect(feet[2]).toBeCloseTo(-10);
  });

  it("drops missing samples and standing-still cadence instead of drawing zeros", () => {
    const series = streams({ cadence: [170, null, 0, 174], elevationM: [10, null, 12, 13] }, 4);
    expect(toSeriesPoints(series, "km", "cadence")).toEqual([
      { distanceInUnit: 0, value: 170 },
      { distanceInUnit: 0.3, value: 174 },
    ]);
    expect(toSeriesPoints(series, "km", "elevation").map((point) => point.value)).toEqual([
      10, 12, 13,
    ]);
  });

  it("gives no points for a series the watch did not record or a manual entry without samples", () => {
    expect(toSeriesPoints(streams({ cadence: null }), "km", "cadence")).toEqual([]);
    expect(toSeriesPoints(streams({ elevationM: null }), "km", "elevation")).toEqual([]);
    const manual = {
      elapsedS: [],
      distanceM: [],
      hr: [],
      cadence: [],
      elevationM: [],
      speedMps: [],
    };
    expect(toSeriesPoints(manual, "km", "cadence")).toEqual([]);
  });
});

describe("seriesStretches", () => {
  it("averages the samples of each whole km, ending with the run's last distance", () => {
    const points: SeriesPoint[] = [
      { distanceInUnit: 0, value: 160 },
      { distanceInUnit: 0.5, value: 170 },
      { distanceInUnit: 1, value: 180 },
      { distanceInUnit: 1.5, value: 172 },
      { distanceInUnit: 2.2, value: 176 },
    ];
    expect(seriesStretches(points)).toEqual([
      { upTo: 1, average: 170 },
      { upTo: 2, average: 172 },
      { upTo: 2.2, average: 176 },
    ]);
  });

  it("closes the last whole km with a sample at exactly its end instead of opening another", () => {
    const points: SeriesPoint[] = [
      { distanceInUnit: 0.5, value: 10 },
      { distanceInUnit: 1, value: 20 },
    ];
    expect(seriesStretches(points)).toEqual([{ upTo: 1, average: 15 }]);
  });
});

describe("SeriesChart", () => {
  beforeEach(() => {
    // jsdom has no layout; give Recharts' ResponsiveContainer a phone-width box to measure.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 358, height: 160 }),
    );
  });

  it("draws cadence as one line over distance with km ticks", () => {
    const { container } = render(
      <SeriesChart points={toSeriesPoints(streams(), "km", "cadence")} unit="km" kind="cadence" />,
    );
    expect(screen.getByRole("img", { name: "Cadence chart" })).toBeInTheDocument();
    expect(linePoints(container)).toBe(31);
    expect(ticks(container)).toEqual(["0.0km", "1.0km", "2.0km", "3.0km", "170", "175"]);
    expect(screen.getByText("Steps per minute")).toHaveClass("text-caption", "text-ink-2");
    expect(container.querySelector(".recharts-line-curve")).toHaveAttribute("stroke-width", "2");
  });

  it("draws elevation in feet over miles when the runner uses miles", () => {
    const { container } = render(
      <SeriesChart
        points={toSeriesPoints(streams({}, 41), "mi", "elevation")}
        unit="mi"
        kind="elevation"
      />,
    );
    expect(screen.getByRole("img", { name: "Elevation chart" })).toBeInTheDocument();
    expect(screen.getByText("Feet above sea level")).toBeInTheDocument();
    // 4 km is 2.49 mi, ticks every half mile; 20 to 60 m is 66 to 197 ft.
    expect(ticks(container)).toEqual([
      "0.0mi",
      "0.5mi",
      "1.0mi",
      "1.5mi",
      "2.0mi",
      "50",
      "100",
      "150",
      "200",
    ]);
  });

  it("downsamples a long run to 600 points", () => {
    const { container } = render(
      <SeriesChart
        points={toSeriesPoints(streams({}, 2000), "km", "elevation")}
        unit="km"
        kind="elevation"
      />,
    );
    expect(linePoints(container)).toBe(600);
  });

  it.each([
    { kind: "cadence" as const, sentence: "No cadence recorded." },
    { kind: "elevation" as const, sentence: "No elevation recorded." },
  ])("shows one sentence and no chart without points ($kind)", ({ kind, sentence }) => {
    render(<SeriesChart points={[]} unit="km" kind={kind} />);
    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says why it draws nothing for a treadmill run without distance (indoor run)", () => {
    const points = toSeriesPoints(streams({ distanceM: Array(31).fill(0) }), "km", "cadence");
    render(<SeriesChart points={points} unit="km" kind="cadence" />);
    expect(screen.getByText("No distance recorded to chart cadence over.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("switches between the chart and a table of one average per km", async () => {
    render(
      <SeriesChart points={toSeriesPoints(streams(), "km", "cadence")} unit="km" kind="cadence" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Show table" }));

    const table = screen.getByRole("table", { name: "Cadence" });
    expect(within(table).getByRole("columnheader", { name: "Cadence spm" })).toBeInTheDocument();
    // 3 km in 100 m samples: (0, 1], (1, 2], (2, 3].
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByRole("row", { name: "3.0 km 172" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Cadence chart" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(screen.getByRole("img", { name: "Cadence chart" })).toBeInTheDocument();
  });
});
