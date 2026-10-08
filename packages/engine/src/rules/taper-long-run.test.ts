import { raceDistanceKeySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inTaperLongRunBands, longRunKeepsDay, taperLongRunCapM } from "./taper-long-run";

describe("taper long run", () => {
  it("keeps the long run on its day 6 days out and drops it 5 days out", () => {
    expect(longRunKeepsDay(6)).toBe(true);
    expect(longRunKeepsDay(5)).toBe(false);
    expect(longRunKeepsDay(0)).toBe(false);
    expect(taperLongRunCapM({ distanceKey: "half", daysOut: 5, peakLongRunM: 16_800 })).toBe(0);
  });

  it("caps the long run 6 to 13 days out at 70% of the peak long run, a marathon's at 60%, in whole meters", () => {
    for (const daysOut of [6, 13]) {
      expect(taperLongRunCapM({ distanceKey: "half", daysOut, peakLongRunM: 16_801 })).toBe(11_760);
      expect(taperLongRunCapM({ distanceKey: "marathon", daysOut, peakLongRunM: 21_600 })).toBe(
        12_960,
      );
    }
  });

  it("leaves a 5K, 10K or half long run 14 days out to its other caps", () => {
    for (const distanceKey of ["5k", "10k", "half"] as const) {
      expect(taperLongRunCapM({ distanceKey, daysOut: 14, peakLongRunM: 16_800 })).toBeNull();
    }
  });

  it("caps a marathon long run 14 to 20 days out at 80% and none 21 days out", () => {
    expect(taperLongRunCapM({ distanceKey: "marathon", daysOut: 14, peakLongRunM: 21_600 })).toBe(
      17_280,
    );
    expect(taperLongRunCapM({ distanceKey: "marathon", daysOut: 20, peakLongRunM: 21_600 })).toBe(
      17_280,
    );
    expect(
      taperLongRunCapM({ distanceKey: "marathon", daysOut: 21, peakLongRunM: 21_600 }),
    ).toBeNull();
  });

  it("puts a long run 13 days out inside the taper's bands and one 14 days out outside, a marathon's 20 and 21", () => {
    for (const distanceKey of ["5k", "10k", "half"] as const) {
      expect(inTaperLongRunBands({ distanceKey, daysOut: 13 })).toBe(true);
      expect(inTaperLongRunBands({ distanceKey, daysOut: 14 })).toBe(false);
    }
    expect(inTaperLongRunBands({ distanceKey: "marathon", daysOut: 20 })).toBe(true);
    expect(inTaperLongRunBands({ distanceKey: "marathon", daysOut: 21 })).toBe(false);
    expect(inTaperLongRunBands({ distanceKey: "half", daysOut: 0 })).toBe(true);
  });

  it("puts a long run inside the taper's bands exactly when its days to the race give it a cap", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 40 }),
        (distanceKey, daysOut) => {
          expect(inTaperLongRunBands({ distanceKey, daysOut })).toBe(
            taperLongRunCapM({ distanceKey, daysOut, peakLongRunM: 20_000 }) !== null,
          );
        },
      ),
    );
  });

  it("never caps above the peak long run, and never loosens closer to the race", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1_000, max: 50_000 }),
        (distanceKey, daysOut, peakLongRunM) => {
          const cap = taperLongRunCapM({ distanceKey, daysOut, peakLongRunM });
          const closer = taperLongRunCapM({
            distanceKey,
            daysOut: Math.max(0, daysOut - 1),
            peakLongRunM,
          });
          if (cap === null) {
            expect(daysOut).toBeGreaterThanOrEqual(distanceKey === "marathon" ? 21 : 14);
            return;
          }
          expect(Number.isInteger(cap)).toBe(true);
          expect(cap).toBeLessThanOrEqual(0.8 * peakLongRunM);
          expect(cap === 0).toBe(!longRunKeepsDay(daysOut));
          expect(closer).not.toBeNull();
          expect(closer).toBeLessThanOrEqual(cap);
        },
      ),
    );
  });
});
