import { DISTANCE_METERS } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { predictTimeS, racePace } from "./prediction";

const distanceArb = fc.constantFrom(
  DISTANCE_METERS["5k"],
  DISTANCE_METERS["10k"],
  DISTANCE_METERS.half,
  DISTANCE_METERS.marathon,
);

describe("prediction", () => {
  it("predicts with Riegel's exponent 1.06: a 20:00 5K gives a 41:42 10K", () => {
    expect(predictTimeS({ fromDistanceM: 5000, fromTimeS: 1200, toDistanceM: 10_000 })).toBe(2502);
  });

  it("predicts the same time for the same distance", () => {
    expect(predictTimeS({ fromDistanceM: 10_000, fromTimeS: 2700, toDistanceM: 10_000 })).toBe(
      2700,
    );
  });

  it("adds the 5% marathon margin when predicting the marathon from a shorter distance", () => {
    // 6000 s x 2^1.06 = 12509.4 s, plus 5% = 13134.9 s.
    expect(
      predictTimeS({ fromDistanceM: DISTANCE_METERS.half, fromTimeS: 6000, toDistanceM: 42_195 }),
    ).toBe(13_135);
  });

  it("adds no margin when the marathon predicts the marathon", () => {
    expect(predictTimeS({ fromDistanceM: 42_195, fromTimeS: 14_400, toDistanceM: 42_195 })).toBe(
      14_400,
    );
  });

  it("adds no margin when the marathon predicts a shorter race", () => {
    expect(predictTimeS({ fromDistanceM: 42_195, fromTimeS: 14_400, toDistanceM: 10_000 })).toBe(
      Math.round(14_400 * (10_000 / 42_195) ** 1.06),
    );
  });

  it.each([
    [0, 1200, 5000],
    [5000, 0, 5000],
    [5000, 1200, 0],
    [Number.NaN, 1200, 5000],
    [5000, Number.POSITIVE_INFINITY, 5000],
  ])(
    "rejects %s m in %s s to %s m as a programmer error",
    (fromDistanceM, fromTimeS, toDistanceM) => {
      expect(() => predictTimeS({ fromDistanceM, fromTimeS, toDistanceM })).toThrow(RangeError);
    },
  );

  it("sets the race pace from the prediction when there is no target, banded +-1.5%", () => {
    // 2000 s over 5 km is 400 s/km: 394 to 406.
    expect(
      racePace({ distanceM: 5000, predictedTimeS: 2000, targetTimeS: null, easySlowSPerKm: 600 }),
    ).toEqual({
      band: { fastSPerKm: 394, slowSPerKm: 406 },
      warning: null,
    });
  });

  it("lets a target exactly 5% faster than the prediction set the race pace", () => {
    expect(
      racePace({ distanceM: 5000, predictedTimeS: 2000, targetTimeS: 1900, easySlowSPerKm: 600 }),
    ).toEqual({
      band: { fastSPerKm: 374, slowSPerKm: 386 },
      warning: null,
    });
  });

  it("lets a target 1 s inside the 5% set the race pace", () => {
    expect(
      racePace({ distanceM: 5000, predictedTimeS: 2000, targetTimeS: 1901, easySlowSPerKm: 600 })
        .warning,
    ).toBeNull();
  });

  it("warns target_time_ambitious 1 s past the 5% and keeps the predicted pace", () => {
    expect(
      racePace({ distanceM: 5000, predictedTimeS: 2000, targetTimeS: 1899, easySlowSPerKm: 600 }),
    ).toEqual({
      band: { fastSPerKm: 394, slowSPerKm: 406 },
      warning: { code: "target_time_ambitious", targetTimeS: 1899, predictedTimeS: 2000 },
    });
  });

  it("lets a target slower than the prediction set a slower race pace", () => {
    expect(
      racePace({ distanceM: 5000, predictedTimeS: 2000, targetTimeS: 2200, easySlowSPerKm: 600 }),
    ).toEqual({
      band: { fastSPerKm: 433, slowSPerKm: 447 },
      warning: null,
    });
  });

  it("treats a target slower than the easy band's slow end as no target: a 7:30/km band's 37:30 5K sets the pace, 37:31 does not", () => {
    // 2250 s over 5 km is 450 s/km: 443 to 457. 2251 s is slower than easy running, so the
    // prediction's 400 s/km stands, with no warning.
    expect(
      racePace({ distanceM: 5000, predictedTimeS: 2000, targetTimeS: 2250, easySlowSPerKm: 450 }),
    ).toEqual({ band: { fastSPerKm: 443, slowSPerKm: 457 }, warning: null });
    expect(
      racePace({ distanceM: 5000, predictedTimeS: 2000, targetTimeS: 2251, easySlowSPerKm: 450 }),
    ).toEqual({ band: { fastSPerKm: 394, slowSPerKm: 406 }, warning: null });
  });

  it.each([
    [0, 2000],
    [5000, 0],
    [5000, Number.NaN],
  ])("rejects a race pace for %s m in %s s as a programmer error", (distanceM, predictedTimeS) => {
    expect(() =>
      racePace({ distanceM, predictedTimeS, targetTimeS: null, easySlowSPerKm: 600 }),
    ).toThrow(RangeError);
  });

  it("predicts longer races slower and never faster than the source pace", () => {
    fc.assert(
      fc.property(
        distanceArb,
        distanceArb,
        fc.integer({ min: 900, max: 30_000 }),
        (fromDistanceM, toDistanceM, fromTimeS) => {
          const timeS = predictTimeS({ fromDistanceM, fromTimeS, toDistanceM });
          expect(Number.isInteger(timeS)).toBe(true);
          if (toDistanceM > fromDistanceM) {
            // Riegel's exponent above 1 means the longer race is run at a slower pace.
            expect(timeS / toDistanceM).toBeGreaterThan(fromTimeS / fromDistanceM);
          }
        },
      ),
    );
  });

  it("warns exactly when the target is more than 5% faster, ignores one slower than easy running, and the band always holds its race pace", () => {
    fc.assert(
      fc.property(
        distanceArb,
        fc.integer({ min: 900, max: 30_000 }),
        fc.option(fc.integer({ min: 600, max: 40_000 })),
        fc.integer({ min: 300, max: 900 }),
        (distanceM, predictedTimeS, targetTimeS, easySlowSPerKm) => {
          const { band, warning } = racePace({
            distanceM,
            predictedTimeS,
            targetTimeS,
            easySlowSPerKm,
          });
          const ambitious = targetTimeS !== null && targetTimeS < predictedTimeS * 0.95 - 1e-9;
          const slow = targetTimeS !== null && (targetTimeS * 1000) / distanceM > easySlowSPerKm;
          expect(warning !== null).toBe(ambitious);
          const raceTimeS =
            targetTimeS === null || ambitious || slow ? predictedTimeS : targetTimeS;
          const paceSPerKm = (raceTimeS * 1000) / distanceM;
          expect(band.fastSPerKm).toBeLessThanOrEqual(Math.round(paceSPerKm));
          expect(band.slowSPerKm).toBeGreaterThanOrEqual(Math.round(paceSPerKm));
        },
      ),
    );
  });
});
