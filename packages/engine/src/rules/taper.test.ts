import { raceDistanceKeySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { peakPhaseVolumeM, taperVolumesM } from "./taper";

describe("taper", () => {
  it("steps a 2-week taper to 70% then a race week at 50% of the peak", () => {
    expect(taperVolumesM({ distanceKey: "10k", peakVolumeM: 40_000, weeks: 2 })).toEqual([
      28_000, 20_000,
    ]);
  });

  it("steps a 3-week marathon taper to 80%, 65% and a race week at 50%", () => {
    expect(taperVolumesM({ distanceKey: "marathon", peakVolumeM: 72_000, weeks: 3 })).toEqual([
      57_600, 46_800, 36_000,
    ]);
  });

  it("keeps the last taper weeks, counted back from the race, when fewer fit", () => {
    expect(taperVolumesM({ distanceKey: "marathon", peakVolumeM: 72_000, weeks: 2 })).toEqual([
      46_800, 36_000,
    ]);
    expect(taperVolumesM({ distanceKey: "5k", peakVolumeM: 40_001, weeks: 1 })).toEqual([20_000]);
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
            expect(m).toBeGreaterThanOrEqual(Math.floor(peakVolumeM * 0.4));
            expect(m).toBeLessThanOrEqual(peakVolumeM * 0.8);
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
