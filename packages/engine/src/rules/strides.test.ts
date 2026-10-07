import { sessionStepsSchema, type PlanPaces, type Step } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sessionTarget, stepDurationS } from "./session-target";
import { stridesM, stridesRepeat, withStrides } from "./strides";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // 320 s/km: 20 min is 3750 m
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 },
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 224 }, // 220 s/km: 20 s is 91 m
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};
// Each stride: 20 s at 220 s/km (91 m) and a 60 s jog at 320 s/km (188 m).
const FOUR_STRIDES_M = 4 * (91 + 188);

describe("strides", () => {
  it("repeats a 20 s quick run in the repetition zone and a 60 s easy jog", () => {
    expect(stridesRepeat(4)).toEqual({
      repeat: 4,
      steps: [
        { kind: "run", zone: "repetition", distanceM: null, durationS: 20 },
        { kind: "recovery", zone: "easy", distanceM: null, durationS: 60 },
      ],
    });
    expect(stridesM(4, PACES)).toBe(FOUR_STRIDES_M);
    expect(stridesM(6, PACES)).toBe(6 * (91 + 188));
  });

  it("carves strides out of the run, keeping its distance: 20 min left of a 4866 m run, then 4 strides", () => {
    const steps = withStrides({ distanceM: 3750 + FOUR_STRIDES_M, count: 4, paces: PACES });
    expect(steps).toEqual([
      { kind: "run", zone: "easy", distanceM: 3750, durationS: null },
      stridesRepeat(4),
    ]);
    expect(sessionTarget(steps, PACES)).toMatchObject({
      distanceM: 3750 + FOUR_STRIDES_M,
      zone: "easy",
    });
  });

  it("keeps strides when the run step rounds to 20 min and drops them 1 m shorter", () => {
    // 3749 m at 320 s/km is 1199.7 s, which the plan shows as 1200 s; 3748 m is 1199 s.
    expect(withStrides({ distanceM: 3749 + FOUR_STRIDES_M, count: 4, paces: PACES })[0]).toEqual({
      kind: "run",
      zone: "easy",
      distanceM: 3749,
      durationS: null,
    });
    expect(withStrides({ distanceM: 3748 + FOUR_STRIDES_M, count: 4, paces: PACES })).toEqual([
      { kind: "run", zone: "easy", distanceM: 3748 + FOUR_STRIDES_M, durationS: null },
    ]);
  });

  it("rejects fewer than 2 strides as a programmer error: a repeat holds at least 2", () => {
    expect(() => stridesRepeat(1)).toThrow(RangeError);
  });

  it("keeps the run's distance and at least 20 min easy before any strides", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30_000 }),
        fc.integer({ min: 2, max: 10 }),
        (distanceM, count) => {
          const steps = withStrides({ distanceM, count, paces: PACES });
          expect(sessionStepsSchema.parse(steps)).toEqual(steps);
          expect(sessionTarget(steps, PACES).distanceM).toBe(distanceM);
          expect(sessionTarget(steps, PACES).zone).toBe("easy");
          if (steps.length === 2) {
            expect(stepDurationS(steps[0] as Step, PACES)).toBeGreaterThanOrEqual(1200);
          } else {
            expect(steps).toEqual([{ kind: "run", zone: "easy", distanceM, durationS: null }]);
          }
        },
      ),
    );
  });
});
