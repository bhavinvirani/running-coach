import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { baseCurveM, downWeekM, isDownWeek, weekTargetM } from "./volume-curve";

describe("volume curve", () => {
  it("climbs 10% a week from the start volume in whole meters", () => {
    expect(baseCurveM({ startVolumeM: 20_000, peakVolumeM: 48_000, weeks: 4 })).toEqual([
      20_000, 22_000, 24_200, 26_620,
    ]);
  });

  it("stops at the peak, one week under it reaching it exactly, then holds", () => {
    expect(baseCurveM({ startVolumeM: 36_364, peakVolumeM: 40_000, weeks: 3 })).toEqual([
      36_364, 40_000, 40_000,
    ]);
    expect(baseCurveM({ startVolumeM: 36_363, peakVolumeM: 40_000, weeks: 3 })).toEqual([
      36_363, 39_999, 40_000,
    ]);
  });

  it("holds a start volume already above the peak instead of cutting it", () => {
    expect(baseCurveM({ startVolumeM: 60_000, peakVolumeM: 40_000, weeks: 3 })).toEqual([
      60_000, 60_000, 60_000,
    ]);
  });

  it("gives no weeks for a plan with no pre-taper weeks", () => {
    expect(baseCurveM({ startVolumeM: 20_000, peakVolumeM: 40_000, weeks: 0 })).toEqual([]);
  });

  it("makes every 4th week a down week", () => {
    expect([1, 2, 3, 4, 5, 7, 8, 12].map(isDownWeek)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      true,
      true,
    ]);
  });

  it("cuts a down week to 80% of the curve, in whole meters", () => {
    expect(downWeekM(30_000)).toBe(24_000);
    expect(downWeekM(30_001)).toBe(24_000);
  });

  it("starts week 1 at the curve and caps a climbing week at +10% over the last non-down week", () => {
    expect(weekTargetM({ kind: "climb", curveM: 20_000, previousNonDownWeekM: null })).toBe(20_000);
    expect(weekTargetM({ kind: "climb", curveM: 33_000, previousNonDownWeekM: 30_000 })).toBe(
      33_000,
    );
    expect(weekTargetM({ kind: "climb", curveM: 32_999, previousNonDownWeekM: 30_000 })).toBe(
      32_999,
    );
    expect(weekTargetM({ kind: "climb", curveM: 33_001, previousNonDownWeekM: 30_000 })).toBe(
      33_000,
    );
  });

  it("keeps a down week or a taper week from rising over the week before it", () => {
    expect(weekTargetM({ kind: "down", curveM: 30_000, previousWeekM: 25_000 })).toBe(24_000);
    expect(weekTargetM({ kind: "down", curveM: 30_000, previousWeekM: 20_000 })).toBe(20_000);
    expect(weekTargetM({ kind: "eased", volumeM: 28_000, previousWeekM: 27_999 })).toBe(27_999);
    expect(weekTargetM({ kind: "eased", volumeM: 28_000, previousWeekM: 28_000 })).toBe(28_000);
    expect(weekTargetM({ kind: "eased", volumeM: 28_000, previousWeekM: null })).toBe(28_000);
  });

  it("climbs at most 10% a week, never falls, and never passes the larger of start and peak", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 15_000, max: 120_000 }),
        fc.integer({ min: 40_000, max: 72_000 }),
        fc.integer({ min: 1, max: 40 }),
        (startVolumeM, peakVolumeM, weeks) => {
          const curve = baseCurveM({ startVolumeM, peakVolumeM, weeks });
          expect(curve).toHaveLength(weeks);
          expect(curve[0]).toBe(startVolumeM);
          curve.slice(1).forEach((m, k) => {
            const previous = curve[k]!;
            expect(Number.isInteger(m)).toBe(true);
            expect(m).toBeGreaterThanOrEqual(previous);
            expect(m).toBeLessThanOrEqual(Math.floor(previous * 1.1));
            expect(m).toBeLessThanOrEqual(Math.max(startVolumeM, peakVolumeM));
          });
        },
      ),
    );
  });

  it("never sets a climbing week above +10% of the last non-down week or an eased week above the last", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 150_000 }),
        fc.integer({ min: 1, max: 150_000 }),
        (volumeM, previousM) => {
          expect(
            weekTargetM({ kind: "climb", curveM: volumeM, previousNonDownWeekM: previousM }),
          ).toBeLessThanOrEqual(Math.floor(previousM * 1.1));
          expect(
            weekTargetM({ kind: "down", curveM: volumeM, previousWeekM: previousM }),
          ).toBeLessThanOrEqual(Math.min(previousM, volumeM * 0.8));
          expect(
            weekTargetM({ kind: "eased", volumeM, previousWeekM: previousM }),
          ).toBeLessThanOrEqual(previousM);
        },
      ),
    );
  });
});
