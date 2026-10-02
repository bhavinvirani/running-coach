import { raceDistanceKeySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { peakPhaseVolumeM, taperVolumesM } from "./taper";

describe("taper", () => {
  it("steps a 2-week taper to 65% then a race week at 40% of the peak, a 60% cut", () => {
    expect(taperVolumesM({ distanceKey: "10k", peakVolumeM: 40_000, weeks: 2 })).toEqual([
      26_000, 16_000,
    ]);
  });

  it("steps a 3-week marathon taper to 80%, 60% and a race week at 40%", () => {
    expect(taperVolumesM({ distanceKey: "marathon", peakVolumeM: 72_000, weeks: 3 })).toEqual([
      57_600, 43_200, 28_800,
    ]);
  });

  it("keeps the last taper weeks, counted back from the race, when fewer fit", () => {
    expect(taperVolumesM({ distanceKey: "marathon", peakVolumeM: 72_000, weeks: 2 })).toEqual([
      43_200, 28_800,
    ]);
    expect(taperVolumesM({ distanceKey: "5k", peakVolumeM: 40_000, weeks: 1 })).toEqual([16_000]);
  });

  it("rounds up to whole meters so the race week never cuts more than 60%: 1 m over 40% of the peak", () => {
    // 40% of 40_001 m is 16_000.4 m; 16_000 m would be a 60.001% cut.
    expect(taperVolumesM({ distanceKey: "5k", peakVolumeM: 40_001, weeks: 1 })).toEqual([16_001]);
    expect(taperVolumesM({ distanceKey: "half", peakVolumeM: 56_003, weeks: 2 })).toEqual([
      36_402, 22_402,
    ]);
  });

  it.each([0, 4])("rejects %s taper weeks for a 2-week taper as a programmer error", (weeks) => {
    expect(() => taperVolumesM({ distanceKey: "5k", peakVolumeM: 40_000, weeks })).toThrow(
      RangeError,
    );
  });

  it("takes the peak from the peak-phase weeks, then any pre-taper week, then the start volume", () => {
    expect(
      peakPhaseVolumeM({
        weeks: [
          { phase: "build", distanceM: 50_000 },
          { phase: "peak", distanceM: 44_000 },
          { phase: "peak", distanceM: 46_000 },
        ],
        startVolumeM: 20_000,
      }),
    ).toBe(46_000);
    expect(
      peakPhaseVolumeM({
        weeks: [
          { phase: "build", distanceM: 30_000 },
          { phase: "build", distanceM: 33_000 },
        ],
        startVolumeM: 20_000,
      }),
    ).toBe(33_000);
    expect(peakPhaseVolumeM({ weeks: [], startVolumeM: 20_000 })).toBe(20_000);
  });

  it("cuts every taper week to between 40% and 80% of the peak, the race week to 40-60%, never rising", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 10_000, max: 150_000 }),
        fc.integer({ min: 1, max: 3 }),
        (distanceKey, peakVolumeM, wanted) => {
          const weeks = Math.min(wanted, distanceKey === "marathon" ? 3 : 2);
          const volumes = taperVolumesM({ distanceKey, peakVolumeM, weeks });
          expect(volumes).toHaveLength(weeks);
          volumes.forEach((m, k) => {
            expect(Number.isInteger(m)).toBe(true);
            expect(m).toBeGreaterThanOrEqual(peakVolumeM * 0.4);
            // Whole meters rounded up: at most 1 m over the 80% share.
            expect(m).toBeLessThanOrEqual(Math.ceil(peakVolumeM * 0.8));
            if (k > 0) expect(m).toBeLessThanOrEqual(volumes[k - 1]!);
          });
          const raceWeek = volumes.at(-1)!;
          expect(raceWeek).toBeGreaterThanOrEqual(peakVolumeM * 0.4);
          expect(raceWeek).toBeLessThanOrEqual(peakVolumeM * 0.6);
        },
      ),
    );
  });
});
