import type { HrZoneTime } from "@running-coach/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HrZonesChart } from "./hr-zones-chart";

// A 52:18 run, mostly in zone 3, as Garmin's get_activity_hr_in_timezones gives it.
const zones: HrZoneTime[] = [
  { zone: 1, lowBpm: 98, seconds: 120 },
  { zone: 2, lowBpm: 118, seconds: 600 },
  { zone: 3, lowBpm: 137, seconds: 1500 },
  { zone: 4, lowBpm: 155, seconds: 800 },
  { zone: 5, lowBpm: 172, seconds: 118 },
];

function bars(container: HTMLElement) {
  return [...container.querySelectorAll(".recharts-bar-rectangle path")];
}

/** Axis and bar labels as drawn; Recharts puts each word in its own tspan, so "Z3 137+" reads "Z3137+". */
function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("text")].map((text) => text.textContent ?? "");
}

describe("HrZonesChart", () => {
  beforeEach(() => {
    // jsdom has no layout; give Recharts' ResponsiveContainer a phone-width box to measure.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 358, height: 176 }),
    );
  });

  it("draws one bar per zone in its zone color, labelled with the zone, its low bpm and the time", () => {
    const { container } = render(<HrZonesChart zones={zones} />);
    expect(screen.getByRole("img", { name: "Heart rate zones chart" })).toBeInTheDocument();
    expect(bars(container).map((bar) => bar.getAttribute("fill"))).toEqual([
      "var(--color-z1)",
      "var(--color-z2)",
      "var(--color-z3)",
      "var(--color-z4)",
      "var(--color-z5)",
    ]);
    expect(labels(container)).toEqual(
      expect.arrayContaining(["Z198+", "Z3137+", "Z5172+", "02:00", "25:00", "01:58"]),
    );
  });

  it("maps each zone to its zone token, the only place those tokens appear", () => {
    const { container } = render(<HrZonesChart zones={zones} />);
    const style = container.querySelector("style")?.textContent ?? "";
    for (const zone of [1, 2, 3, 4, 5]) {
      expect(style).toContain(`--color-z${zone}: var(--color-zone-${zone});`);
    }
  });

  it("draws the widest bar for the zone with the most time", () => {
    const { container } = render(<HrZonesChart zones={zones} />);
    const widths = bars(container).map((bar) => Number(bar.getAttribute("width")));
    expect(Math.max(...widths)).toBe(widths[2]);
  });

  it("orders zones 1 to 5 whatever order they arrive in", () => {
    const { container } = render(<HrZonesChart zones={[...zones].reverse()} />);
    expect(bars(container)[0]).toHaveAttribute("fill", "var(--color-z1)");
  });

  it.each([
    { corner: "no zones", given: [] },
    { corner: "no time in any zone", given: zones.map((zone) => ({ ...zone, seconds: 0 })) },
  ])("shows one sentence and no chart ($corner)", ({ given }) => {
    render(<HrZonesChart zones={given} />);
    expect(screen.getByText("No time in heart rate zones recorded.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("switches between the chart and a table with each zone's share of the run", async () => {
    render(<HrZonesChart zones={zones} />);
    await userEvent.click(screen.getByRole("button", { name: "Show table" }));

    const table = screen.getByRole("table", { name: "Heart rate zones" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    // 1500 of 3138 s.
    expect(within(table).getByRole("row", { name: "Z3 137+ 25:00 48%" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: "Z5 172+ 01:58 4%" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Heart rate zones chart" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(screen.getByRole("img", { name: "Heart rate zones chart" })).toBeInTheDocument();
  });

  it("labels a zone without a lower bound by its number alone", async () => {
    render(<HrZonesChart zones={[{ zone: 1, lowBpm: 0, seconds: 60 }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Show table" }));
    expect(screen.getByRole("row", { name: "Z1 01:00 100%" })).toBeInTheDocument();
  });
});
