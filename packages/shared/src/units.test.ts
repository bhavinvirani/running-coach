import { describe, expect, it } from "vitest";
import {
  METERS_PER_MILE,
  distanceInUnits,
  isGpsGlitch,
  paceSecondsPerUnit,
  speedToPaceSecondsPerUnit,
} from "./units";

describe("distanceInUnits", () => {
  it("converts meters to kilometers and miles", () => {
    expect(distanceInUnits(21097.5, "km")).toBeCloseTo(21.0975);
    expect(distanceInUnits(METERS_PER_MILE * 10, "mi")).toBeCloseTo(10);
  });
});

describe("paceSecondsPerUnit", () => {
  it("returns seconds per kilometer and per mile", () => {
    expect(paceSecondsPerUnit(5000, 1625, "km")).toBe(325);
    expect(paceSecondsPerUnit(METERS_PER_MILE, 480, "mi")).toBeCloseTo(480);
  });

  it("returns null for an indoor run with no distance", () => {
    expect(paceSecondsPerUnit(0, 1800, "km")).toBeNull();
  });
});

describe("speedToPaceSecondsPerUnit", () => {
  it("returns null when standing still", () => {
    expect(speedToPaceSecondsPerUnit(0, "km")).toBeNull();
  });

  it("converts meters per second to seconds per kilometer", () => {
    expect(speedToPaceSecondsPerUnit(1000 / 300, "km")).toBeCloseTo(300);
  });
});

describe("isGpsGlitch", () => {
  it("marks a split faster than 2:00/km as a GPS glitch", () => {
    expect(isGpsGlitch(1000, 119)).toBe(true);
  });

  it("keeps a split at exactly 2:00/km and slower", () => {
    expect(isGpsGlitch(1000, 120)).toBe(false);
    expect(isGpsGlitch(1000, 330)).toBe(false);
  });

  it("does not mark a split with no distance", () => {
    expect(isGpsGlitch(0, 60)).toBe(false);
  });
});
