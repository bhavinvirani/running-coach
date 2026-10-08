import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DistanceBar } from "./distance-bar";

function bar(distanceM: number, goalM: number) {
  const { container } = render(<DistanceBar distanceM={distanceM} goalM={goalM} />);
  const svg = container.querySelector("svg");
  const [track, fill] = Array.from(svg?.querySelectorAll("rect") ?? []);
  return { svg, track, fill };
}

describe("DistanceBar", () => {
  it("fills chart-series on a surface-2 track as far as the distance goes toward the goal", () => {
    const { svg, track, fill } = bar(312_400, 650_000);

    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-3", "w-full");
    expect(track).toHaveAttribute("width", "100%");
    expect(track).toHaveClass("fill-surface-2");
    // 312.4 of 650 km is 48.06 %.
    expect(fill).toHaveAttribute("width", "48.1%");
    expect(fill).toHaveClass("fill-chart-series");
    expect(fill).toHaveAttribute("rx", "6");
  });

  it("stays full for a pair past its goal", () => {
    expect(bar(702_300, 650_000).fill).toHaveAttribute("width", "100%");
  });

  it("draws the track alone for a pair that has not run yet", () => {
    const { track, fill } = bar(0, 650_000);
    expect(track).toBeDefined();
    expect(fill).toBeUndefined();
  });
});
