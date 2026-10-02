import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LapsChart, type LapPoint } from "./laps-chart";

// Shaped like the seed runner's tempo session: 2 km easy, 6 km at 4:55, 2 km easy.
const tempoLaps: LapPoint[] = [
  { index: 1, paceSecondsPerUnit: 348, distanceInUnit: 1 },
  { index: 2, paceSecondsPerUnit: 341, distanceInUnit: 1 },
  { index: 3, paceSecondsPerUnit: 298, distanceInUnit: 1 },
  { index: 4, paceSecondsPerUnit: 292, distanceInUnit: 1 },
  { index: 5, paceSecondsPerUnit: 296, distanceInUnit: 1 },
  { index: 6, paceSecondsPerUnit: 291, distanceInUnit: 1 },
  { index: 7, paceSecondsPerUnit: 301, distanceInUnit: 1 },
  { index: 8, paceSecondsPerUnit: 297, distanceInUnit: 1 },
  { index: 9, paceSecondsPerUnit: 344, distanceInUnit: 1 },
  { index: 10, paceSecondsPerUnit: 339, distanceInUnit: 1.02 },
];

function bars(container: HTMLElement) {
  return container.querySelectorAll(".recharts-bar-rectangle");
}

describe("LapsChart", () => {
  beforeEach(() => {
    // jsdom has no layout; give Recharts' ResponsiveContainer a phone-width box to measure.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 358, height: 192 }),
    );
  });

  it("draws one bar per lap with pace ticks and the target line", () => {
    const { container } = render(
      <LapsChart
        laps={tempoLaps}
        unit="km"
        target={{ paceSecondsPerUnit: 295, label: "Target" }}
      />,
    );
    expect(screen.getByRole("img", { name: "Lap pace chart" })).toBeInTheDocument();
    expect(bars(container)).toHaveLength(10);
    expect(screen.getByText("Target 4:55")).toBeInTheDocument();
    expect(screen.getByText("5:00")).toBeInTheDocument();
    expect(screen.queryByText(/GPS glitch/)).not.toBeInTheDocument();
  });

  it("draws faster laps taller", () => {
    const { container } = render(<LapsChart laps={tempoLaps} unit="km" />);
    const heights = [...bars(container)].map((bar) =>
      Number(bar.querySelector("path")?.getAttribute("height") ?? bar.getAttribute("height")),
    );
    // Lap 6 (4:51) is the fastest, lap 1 (5:48) the slowest.
    expect(Math.max(...heights)).toBe(heights[5]);
    expect(Math.min(...heights)).toBe(heights[0]);
  });

  it("shows one sentence and no chart when there are no laps", () => {
    const { container } = render(<LapsChart laps={[]} unit="km" />);
    expect(screen.getByText("No laps recorded for this run.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(bars(container)).toHaveLength(0);
  });

  it("leaves out a 1:50/km lap as a GPS glitch and says so", async () => {
    const laps = [...tempoLaps, { index: 11, paceSecondsPerUnit: 110, distanceInUnit: 1 }];
    const { container } = render(<LapsChart laps={laps} unit="km" />);
    expect(bars(container)).toHaveLength(10);
    expect(screen.getByText("1 lap left out as a GPS glitch.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show table" }));
    const glitchRow = screen.getByRole("row", { name: /^11/ });
    expect(within(glitchRow).getByText("GPS glitch")).toBeInTheDocument();
  });

  it("converts the glitch threshold to miles", () => {
    // 3:00/mi is 1:52/km: a glitch. 6:00/mi is a real sprint.
    const laps: LapPoint[] = [
      { index: 1, paceSecondsPerUnit: 180, distanceInUnit: 1 },
      { index: 2, paceSecondsPerUnit: 360, distanceInUnit: 1 },
      { index: 3, paceSecondsPerUnit: 480, distanceInUnit: 1 },
    ];
    const { container } = render(<LapsChart laps={laps} unit="mi" />);
    expect(bars(container)).toHaveLength(2);
    expect(screen.getByText("1 lap left out as a GPS glitch.")).toBeInTheDocument();
  });

  it("switches between the chart and a table of every lap", async () => {
    render(<LapsChart laps={tempoLaps} unit="km" />);
    await userEvent.click(screen.getByRole("button", { name: "Show table" }));

    const table = screen.getByRole("table", { name: "Laps" });
    expect(within(table).getAllByRole("row")).toHaveLength(11);
    expect(within(table).getByRole("columnheader", { name: "Pace /km" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: "10 1.0 km 5:39" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Lap pace chart" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(screen.getByRole("img", { name: "Lap pace chart" })).toBeInTheDocument();
  });
});
