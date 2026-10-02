import { DISTANCE_METERS } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { DISTANCE_KEYS, distanceLabel, personalBestName } from "./distance-labels";

describe("distance labels", () => {
  it("names the eleven distances shortest first", () => {
    expect(DISTANCE_KEYS.map(distanceLabel)).toEqual([
      "1K",
      "1 mi",
      "2 mi",
      "5K",
      "5 mi",
      "10K",
      "15K",
      "10 mi",
      "20K",
      "Half",
      "Marathon",
    ]);
  });

  it("orders the keys by their meters, so the badges read shortest first", () => {
    const meters = DISTANCE_KEYS.map((key) => DISTANCE_METERS[key]);
    expect(meters).toEqual([...meters].sort((a, b) => a - b));
  });
});

describe("personalBestName", () => {
  it("names every distance a run holds as a best after PB", () => {
    expect(personalBestName(["5k"])).toBe("PB 5K");
    expect(personalBestName(["5k", "10k", "half"])).toBe("PB 5K, 10K, Half");
  });

  it("has no name for a run that holds no best", () => {
    expect(personalBestName([])).toBeNull();
  });
});
