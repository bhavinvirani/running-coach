import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clampWeeklyVolume, maxWeeklyVolumeM } from "./weekly-volume";

// Realistic weekly volumes: 1 km to 250 km, in meters, plus fractional meters from upstream sums.
const weekM = fc.double({ min: 1_000, max: 250_000, noNaN: true, noDefaultInfinity: true });
const proposalM = fc.double({ min: 0, max: 400_000, noNaN: true, noDefaultInfinity: true });

describe("weekly volume", () => {
  it("allows at most 10% more than last week, in whole meters", () => {
    expect(maxWeeklyVolumeM(30_000)).toBe(33_000);
    expect(maxWeeklyVolumeM(12_345)).toBe(13_579);
  });

  it("keeps a proposal of exactly +10% unchanged", () => {
    expect(clampWeeklyVolume({ previousWeekM: 30_000, proposedM: 33_000 })).toEqual({
      volumeM: 33_000,
      clamped: false,
    });
  });

  it("keeps a proposal 1 m below the cap unchanged", () => {
    expect(clampWeeklyVolume({ previousWeekM: 30_000, proposedM: 32_999 })).toEqual({
      volumeM: 32_999,
      clamped: false,
    });
  });

  it("clamps a proposal 1 m above the cap down to the cap", () => {
    expect(clampWeeklyVolume({ previousWeekM: 30_000, proposedM: 33_001 })).toEqual({
      volumeM: 33_000,
      clamped: true,
    });
  });

  it("passes a proposal lower than last week unchanged", () => {
    expect(clampWeeklyVolume({ previousWeekM: 30_000, proposedM: 18_000 })).toEqual({
      volumeM: 18_000,
      clamped: false,
    });
  });

  it("passes a zero-volume week unchanged", () => {
    expect(clampWeeklyVolume({ previousWeekM: 30_000, proposedM: 0 })).toEqual({
      volumeM: 0,
      clamped: false,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects previous week %s as a programmer error (re-entry owns weeks after zero volume)",
    (previousWeekM) => {
      expect(() => maxWeeklyVolumeM(previousWeekM)).toThrow(RangeError);
      expect(() => clampWeeklyVolume({ previousWeekM, proposedM: 10_000 })).toThrow(RangeError);
    },
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects proposal %s as a programmer error",
    (proposedM) => {
      expect(() => clampWeeklyVolume({ previousWeekM: 30_000, proposedM })).toThrow(RangeError);
    },
  );

  it("never exceeds floor(previous week x 1.1) over generated weeks", () => {
    fc.assert(
      fc.property(weekM, proposalM, (previousWeekM, proposedM) => {
        const { volumeM } = clampWeeklyVolume({ previousWeekM, proposedM });
        expect(volumeM).toBeLessThanOrEqual(Math.floor(previousWeekM * 1.1));
      }),
    );
  });

  it("never exceeds the proposal over generated weeks", () => {
    fc.assert(
      fc.property(weekM, proposalM, (previousWeekM, proposedM) => {
        expect(clampWeeklyVolume({ previousWeekM, proposedM }).volumeM).toBeLessThanOrEqual(
          proposedM,
        );
      }),
    );
  });

  it("reports clamped exactly when the proposal was above the cap", () => {
    fc.assert(
      fc.property(weekM, proposalM, (previousWeekM, proposedM) => {
        const { clamped } = clampWeeklyVolume({ previousWeekM, proposedM });
        expect(clamped).toBe(proposedM > maxWeeklyVolumeM(previousWeekM));
      }),
    );
  });

  it("is idempotent: clamping a clamped volume changes nothing", () => {
    fc.assert(
      fc.property(weekM, proposalM, (previousWeekM, proposedM) => {
        const once = clampWeeklyVolume({ previousWeekM, proposedM });
        const twice = clampWeeklyVolume({ previousWeekM, proposedM: once.volumeM });
        expect(twice).toEqual({ volumeM: once.volumeM, clamped: false });
      }),
    );
  });
});
