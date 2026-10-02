import { describe, expect, it } from "vitest";
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
} from "../../src/coach/format";

// The coach writes numbers the way the run screen shows them (apps/web/src/lib/format.ts).

describe("coach format", () => {
  it("writes distances with one decimal, like the run screen", () => {
    expect(formatDistance(18_000, "km")).toBe("18.0 km");
    expect(formatDistance(18_000, "mi")).toBe("11.2 mi");
  });

  it("pads the minutes of a duration under an hour and keeps h:mm:ss above it", () => {
    expect(formatDuration(330)).toBe("05:30");
    expect(formatDuration(6120)).toBe("1:42:00");
  });

  it("writes pace as m:ss per unit, rounding seconds first so it never reads 4:60", () => {
    expect(formatPace(18_000, 6120, "km")).toBe("5:40 /km");
    expect(formatPace(1000, 299.6, "km")).toBe("5:00 /km");
    expect(formatPace(0, 1800, "km")).toBeNull();
  });

  it("writes elevation in meters with km and in feet with miles", () => {
    expect(formatElevation(142, "km")).toBe("142 m");
    expect(formatElevation(88, "mi")).toBe("289 ft");
  });
});
