import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { taperPeakM } from "./taper";

describe("taper", () => {
  it("cuts from the largest whole week before the taper, a down week's neighbour too, else the start volume", () => {
    expect(taperPeakM({ weeksM: [50_000, 40_000, 46_000], startVolumeM: 20_000 })).toBe(50_000);
    expect(taperPeakM({ weeksM: [], startVolumeM: 20_000 })).toBe(20_000);
  });

  it("cuts from a week the plan built, never above the largest of them", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 150_000 }), { minLength: 1, maxLength: 52 }),
        fc.integer({ min: 1, max: 150_000 }),
        (weeksM, startVolumeM) => {
          const peakM = taperPeakM({ weeksM, startVolumeM });
          expect(weeksM).toContain(peakM);
          expect(weeksM.every((m) => m <= peakM)).toBe(true);
        },
      ),
    );
  });
});
