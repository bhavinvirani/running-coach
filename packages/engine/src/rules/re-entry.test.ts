import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reEntryFactor } from "./re-entry";

describe("re-entry", () => {
  it.each([
    [0, 1],
    [6, 1],
    [7, 0.7],
    [8, 0.7],
    [13, 0.7],
    [14, 0.5],
    [15, 0.5],
    [365, 0.5],
  ])(
    "runs at full volume under 7 days off, 70% from 7 and 50% from 14: %s days gives %s",
    (days, factor) => {
      expect(reEntryFactor(days)).toBe(factor);
    },
  );

  it("gives a runner with no runs on record nothing to build from", () => {
    expect(reEntryFactor(null)).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN])("rejects %s days as a programmer error", (days) => {
    expect(() => reEntryFactor(days)).toThrow(RangeError);
  });

  it("never rises with more days off", () => {
    fc.assert(
      fc.property(fc.nat({ max: 400 }), fc.nat({ max: 400 }), (a, b) => {
        const [fewer, more] = a <= b ? [a, b] : [b, a];
        expect(reEntryFactor(more)).toBeLessThanOrEqual(reEntryFactor(fewer));
      }),
    );
  });
});
