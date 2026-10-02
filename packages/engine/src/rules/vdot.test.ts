import { paceZoneSchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pacesFromVdot, paceAtShareSPerKm, roundVdot, vdotFromPerformance } from "./vdot";

const vdotArb = fc.double({ min: 20, max: 85, noNaN: true, noDefaultInfinity: true });
const distanceArb = fc.constantFrom(1500, 3000, 5000, 10_000, 21_097.5, 42_195);
const trainingZones = paceZoneSchema.options.filter(
  (zone): zone is Exclude<typeof zone, "race"> => zone !== "race",
);

describe("vdot", () => {
  it("puts a 19:57 5K at VDOT 50 (Daniels' table, within 0.5)", () => {
    expect(vdotFromPerformance({ distanceM: 5000, timeS: 19 * 60 + 57 })).toBeCloseTo(50, 0);
    expect(Math.abs(vdotFromPerformance({ distanceM: 5000, timeS: 1197 }) - 50)).toBeLessThan(0.5);
  });

  it("puts a 41:21 10K at VDOT 50 (Daniels' table, within 0.5)", () => {
    expect(Math.abs(vdotFromPerformance({ distanceM: 10_000, timeS: 2481 }) - 50)).toBeLessThan(
      0.5,
    );
  });

  it("gives a 5K one second slower a lower VDOT and one second faster a higher one", () => {
    const at = vdotFromPerformance({ distanceM: 5000, timeS: 1197 });
    expect(vdotFromPerformance({ distanceM: 5000, timeS: 1198 })).toBeLessThan(at);
    expect(vdotFromPerformance({ distanceM: 5000, timeS: 1196 })).toBeGreaterThan(at);
  });

  it("gives threshold pace about 4:15/km at VDOT 50 (within 5 s)", () => {
    const { threshold } = pacesFromVdot(50);
    expect(Math.abs((threshold.fastSPerKm + threshold.slowSPerKm) / 2 - 255)).toBeLessThanOrEqual(
      5,
    );
  });

  it("gives VDOT 50 an easy band of about 5:00 to 5:38/km", () => {
    expect(pacesFromVdot(50).easy).toEqual({ fastSPerKm: 300, slowSPerKm: 338 });
  });

  it("solves the VO2 cost for the velocity at a share of VDOT: 100% of VDOT 50 is about 4:00/km", () => {
    // VO2 at 4:00/km (250 m/min) is -4.6 + 0.182258 x 250 + 0.000104 x 250^2 = 47.4645.
    expect(paceAtShareSPerKm(47.4645, 1)).toBeCloseTo(240, 6);
  });

  it("rounds VDOT to one decimal", () => {
    expect(roundVdot(49.95)).toBe(50);
    expect(roundVdot(49.94)).toBe(49.9);
  });

  it.each([
    [0, 1200],
    [-5000, 1200],
    [5000, 0],
    [5000, -1],
    [Number.NaN, 1200],
    [5000, Number.POSITIVE_INFINITY],
  ])("rejects a performance of %s m in %s s as a programmer error", (distanceM, timeS) => {
    expect(() => vdotFromPerformance({ distanceM, timeS })).toThrow(RangeError);
  });

  it("rejects a walk too slow to give a positive VDOT (5K in 4 hours)", () => {
    expect(() => vdotFromPerformance({ distanceM: 5000, timeS: 4 * 3600 })).toThrow(RangeError);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects VDOT %s as a programmer error",
    (vdot) => {
      expect(() => pacesFromVdot(vdot)).toThrow(RangeError);
      expect(() => paceAtShareSPerKm(vdot, 1)).toThrow(RangeError);
    },
  );

  it("gives integer bands, fast end first, easy slowest and repetition fastest, for every VDOT", () => {
    fc.assert(
      fc.property(vdotArb, (vdot) => {
        const paces = pacesFromVdot(vdot);
        for (const zone of trainingZones) {
          const band = paces[zone];
          expect(Number.isInteger(band.fastSPerKm) && Number.isInteger(band.slowSPerKm)).toBe(true);
          expect(band.fastSPerKm).toBeGreaterThan(0);
          expect(band.fastSPerKm).toBeLessThanOrEqual(band.slowSPerKm);
        }
        expect(paces.easy.fastSPerKm).toBeGreaterThan(paces.marathon.slowSPerKm);
        expect(paces.marathon.fastSPerKm).toBeGreaterThan(paces.threshold.slowSPerKm);
        expect(paces.threshold.fastSPerKm).toBeGreaterThan(paces.interval.slowSPerKm);
        expect(paces.interval.fastSPerKm).toBeGreaterThan(paces.repetition.slowSPerKm);
      }),
    );
  });

  it("is monotone: a faster time over the same distance never lowers VDOT", () => {
    fc.assert(
      fc.property(
        distanceArb,
        fc.double({ min: 2, max: 7, noNaN: true }),
        fc.double({ min: 0.001, max: 0.3, noNaN: true }),
        (distanceM, speedMPerS, gain) => {
          const timeS = distanceM / speedMPerS;
          expect(vdotFromPerformance({ distanceM, timeS: timeS * (1 - gain) })).toBeGreaterThan(
            vdotFromPerformance({ distanceM, timeS }),
          );
        },
      ),
    );
  });

  it("is monotone: a higher VDOT never gives a slower pace in any zone", () => {
    fc.assert(
      fc.property(vdotArb, fc.double({ min: 0.5, max: 5, noNaN: true }), (vdot, step) => {
        const slower = pacesFromVdot(vdot);
        const faster = pacesFromVdot(vdot + step);
        expect(faster.threshold.fastSPerKm).toBeLessThanOrEqual(slower.threshold.fastSPerKm);
        expect(faster.easy.slowSPerKm).toBeLessThanOrEqual(slower.easy.slowSPerKm);
      }),
    );
  });
});
