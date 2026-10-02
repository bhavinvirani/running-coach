import { describe, expect, it } from "vitest";
import { formatPlanPace } from "./pace-band";

describe("formatPlanPace", () => {
  it("shows a band in seconds per kilometer as it is with km", () => {
    expect(formatPlanPace({ fastSPerKm: 345, slowSPerKm: 380 }, "km")).toBe("5:45-6:20 /km");
  });

  it("converts a band to minutes per mile (unit conversion)", () => {
    // 345 and 380 s/km are 555.2 and 611.6 s/mi.
    expect(formatPlanPace({ fastSPerKm: 345, slowSPerKm: 380 }, "mi")).toBe("9:15-10:12 /mi");
  });

  it("shows one pace for a band of one pace", () => {
    expect(formatPlanPace({ fastSPerKm: 296, slowSPerKm: 296 }, "km")).toBe("4:56 /km");
  });
});
