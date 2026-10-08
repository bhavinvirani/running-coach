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

  it("makes every 4th week of a fitness plan a down week: 4, 8 and 12", () => {
    const down = (weekNumber: number) => isDownWeek({ weekNumber, firstTaperWeek: null });
    expect([...Array.from({ length: 12 }, (_, k) => k + 1)].filter(down)).toEqual([4, 8, 12]);
  });

  it("counts a race plan's down weeks back from the taper: 15, 11, 7 and 3 when it starts at week 19", () => {
    const down = (weekNumber: number) => isDownWeek({ weekNumber, firstTaperWeek: 19 });
    expect([...Array.from({ length: 20 }, (_, k) => k + 1)].filter(down)).toEqual([3, 7, 11, 15]);
  });

  it("keeps the 3 weeks before the taper loading and has no down week before week 3", () => {
    const downs = (firstTaperWeek: number) =>
      [...Array.from({ length: firstTaperWeek + 1 }, (_, k) => k + 1)].filter((weekNumber) =>
        isDownWeek({ weekNumber, firstTaperWeek }),
      );
    expect(downs(6)).toEqual([]);
    expect(downs(7)).toEqual([3]);
    expect(downs(8)).toEqual([4]);
    expect(downs(10)).toEqual([6]);
    expect(downs(11)).toEqual([3, 7]);
    expect(downs(1)).toEqual([]);
  });

  it("puts a race plan's down weeks 4 apart, the last 4 weeks before the taper, none from week 1 to 2", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 52 }), (firstTaperWeek) => {
        const downs = Array.from({ length: 52 }, (_, k) => k + 1).filter((weekNumber) =>
          isDownWeek({ weekNumber, firstTaperWeek }),
        );
        for (const weekNumber of downs) {
          expect(weekNumber).toBeGreaterThanOrEqual(3);
          expect((firstTaperWeek - weekNumber) % 4).toBe(0);
          expect(firstTaperWeek - weekNumber).toBeGreaterThanOrEqual(4);
        }
        expect(downs).toHaveLength(Math.max(0, Math.floor((firstTaperWeek - 3) / 4)));
      }),
    );
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

  it("cuts a down week to 80% of the curve when the week before reached it", () => {
    expect(weekTargetM({ kind: "down", curveM: 30_000, previousWeekM: 30_000 })).toBe(24_000);
    expect(weekTargetM({ kind: "down", curveM: 30_000, previousWeekM: 40_000 })).toBe(24_000);
  });

  it("cuts a down week to 80% of the week before as built when it lags the curve: 42 592 m gives 34 073 m, not 42 592 m", () => {
    // A half on 4 days from an 8 km longest: the 110% run cap holds weeks 1 to 3 at 35 200, 38 720 and
    // 42 592 m while the curve asks for 40 000, 44 000 and 48 400 m.
    expect(weekTargetM({ kind: "down", curveM: 53_240, previousWeekM: 42_592 })).toBe(34_073);
    expect(weekTargetM({ kind: "down", curveM: 42_593, previousWeekM: 42_592 })).toBe(34_073);
    expect(weekTargetM({ kind: "down", curveM: 42_591, previousWeekM: 42_592 })).toBe(34_072);
  });

  it("keeps a taper week from rising over the week before it", () => {
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

  it("never sets a climbing week above +10% of the last non-down week, a down week above 80% of the week before or an eased week above it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 150_000 }),
        fc.integer({ min: 1, max: 150_000 }),
        (volumeM, previousM) => {
          expect(
            weekTargetM({ kind: "climb", curveM: volumeM, previousNonDownWeekM: previousM }),
          ).toBeLessThanOrEqual(Math.floor(previousM * 1.1));
          expect(weekTargetM({ kind: "down", curveM: volumeM, previousWeekM: previousM })).toBe(
            Math.floor(0.8 * Math.min(previousM, volumeM)),
          );
          expect(
            weekTargetM({ kind: "eased", volumeM, previousWeekM: previousM }),
          ).toBeLessThanOrEqual(previousM);
        },
      ),
    );
  });
});
