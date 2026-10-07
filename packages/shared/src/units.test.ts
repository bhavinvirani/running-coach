import { describe, expect, it } from "vitest";
import {
  METERS_PER_FOOT,
  bpmAtPercentOfMaxHr,
  percentOfMaxHr,
  METERS_PER_MILE,
  distanceInUnits,
  elevationInUnits,
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

describe("elevationInUnits", () => {
  it("keeps meters when distances are in kilometers", () => {
    expect(elevationInUnits(142, "km")).toBe(142);
  });

  it("converts meters to feet when distances are in miles", () => {
    expect(elevationInUnits(METERS_PER_FOOT * 500, "mi")).toBeCloseTo(500);
    expect(elevationInUnits(88, "mi")).toBeCloseTo(288.71, 2);
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

describe("percentOfMaxHr and bpmAtPercentOfMaxHr", () => {
  it("round to whole numbers", () => {
    expect(percentOfMaxHr(137, 196)).toBe(70);
    expect(bpmAtPercentOfMaxHr(70, 196)).toBe(137);
  });

  it("give back Garmin's default floors for a max HR", () => {
    expect([50, 60, 70, 80, 90].map((percent) => bpmAtPercentOfMaxHr(percent, 196))).toEqual([
      98, 118, 137, 157, 176,
    ]);
  });
});
