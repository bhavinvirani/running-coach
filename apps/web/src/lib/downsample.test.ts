import { describe, expect, it } from "vitest";
import { MAX_CHART_POINTS, downsample } from "./downsample";

type Point = { t: number; v: number };

// A fixed, irregular series: no randomness, so failures reproduce.
function series(length: number): Point[] {
  return Array.from({ length }, (_, t) => ({ t, v: Math.sin(t / 17) * 40 + ((t * 7919) % 13) }));
}

const byValue = (point: Point) => point.v;

describe("downsample", () => {
  it("returns a copy of the input when it already fits", () => {
    const input = series(600);
    const output = downsample(input, byValue);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it("returns at most 600 points by default", () => {
    expect(downsample(series(10_000), byValue).length).toBeLessThanOrEqual(MAX_CHART_POINTS);
    expect(downsample(series(601), byValue).length).toBeLessThanOrEqual(MAX_CHART_POINTS);
  });

  it("keeps the first and the last point", () => {
    const input = series(5_000);
    const output = downsample(input, byValue);
    expect(output[0]).toBe(input[0]);
    expect(output.at(-1)).toBe(input.at(-1));
  });

  it("keeps the global minimum and maximum", () => {
    const input = series(5_000);
    input[2_345] = { t: 2_345, v: 1_000 };
    input[4_001] = { t: 4_001, v: -1_000 };
    const output = downsample(input, byValue);
    expect(output).toContain(input[2_345]);
    expect(output).toContain(input[4_001]);
  });

  it("keeps the original order", () => {
    const output = downsample(series(5_000), byValue, 100);
    const times = output.map((point) => point.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("is deterministic", () => {
    const input = series(7_777);
    expect(downsample(input, byValue, 200)).toEqual(downsample(input, byValue, 200));
  });

  it("honours a custom limit", () => {
    expect(downsample(series(1_000), byValue, 50).length).toBeLessThanOrEqual(50);
  });

  it("rejects a limit too small to keep first, last and extremes", () => {
    expect(() => downsample(series(10), byValue, 3)).toThrow(RangeError);
  });
});
