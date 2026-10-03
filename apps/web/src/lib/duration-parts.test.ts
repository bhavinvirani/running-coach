import { describe, expect, it } from "vitest";
import { ZERO_DURATION, durationParts, durationSeconds } from "./duration-parts";

describe("durationParts", () => {
  it("splits a time into hours, minutes and seconds", () => {
    expect(durationParts(6300)).toEqual({ hours: 1, minutes: 45, seconds: 0 });
    expect(durationParts(3281)).toEqual({ hours: 0, minutes: 54, seconds: 41 });
    expect(durationParts(35999)).toEqual({ hours: 9, minutes: 59, seconds: 59 });
  });

  it("keeps hours past 9, which the hours picker then offers (stored time above 9:59:59)", () => {
    expect(durationParts(37230)).toEqual({ hours: 10, minutes: 20, seconds: 30 });
  });

  it("cuts a fraction of a second and reads nothing as zero", () => {
    expect(durationParts(1500.9)).toEqual({ hours: 0, minutes: 25, seconds: 0 });
    expect(durationParts(0)).toEqual(ZERO_DURATION);
  });
});

describe("durationSeconds", () => {
  it("adds the parts back up to seconds", () => {
    expect(durationSeconds({ hours: 1, minutes: 43, seconds: 0 })).toBe(6180);
    expect(durationSeconds({ hours: 0, minutes: 54, seconds: 41 })).toBe(3281);
    expect(durationSeconds(ZERO_DURATION)).toBe(0);
  });

  it("round-trips every split it makes", () => {
    for (const seconds of [1, 59, 60, 3599, 3600, 6972, 35999]) {
      expect(durationSeconds(durationParts(seconds))).toBe(seconds);
    }
  });
});
