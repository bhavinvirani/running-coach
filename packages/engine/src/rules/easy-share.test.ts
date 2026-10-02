import type { PlanPaces, SessionSteps } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hardShareHolds, hardTimeS } from "./easy-share";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 },
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 250, slowSPerKm: 260 }, // 255 s/km
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 224 }, // 220 s/km
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};

describe("easy share", () => {
  it("counts only work steps in hard zones, repeats included", () => {
    const steps: SessionSteps = [
      { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
      {
        repeat: 4,
        steps: [
          { kind: "work", zone: "repetition", distanceM: 400, durationS: null }, // 88 s
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 120 },
        ],
      },
      { kind: "work", zone: "threshold", distanceM: null, durationS: 600 },
      { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
    ];
    expect(hardTimeS(steps, PACES)).toBe(4 * 88 + 600);
  });

  it("counts no hard time in an easy run or in the race itself", () => {
    expect(
      hardTimeS([{ kind: "run", zone: "easy", distanceM: 8000, durationS: null }], PACES),
    ).toBe(0);
    expect(
      hardTimeS([{ kind: "run", zone: "race", distanceM: 5000, durationS: null }], PACES),
    ).toBe(0);
    expect(
      hardTimeS([{ kind: "work", zone: "marathon", distanceM: 5000, durationS: null }], PACES),
    ).toBe(0);
  });

  it("holds at exactly 20% hard time and not 1 s over", () => {
    expect(hardShareHolds({ hardS: 199, totalS: 1000 })).toBe(true);
    expect(hardShareHolds({ hardS: 200, totalS: 1000 })).toBe(true);
    expect(hardShareHolds({ hardS: 201, totalS: 1000 })).toBe(false);
    expect(hardShareHolds({ hardS: 0, totalS: 0 })).toBe(true);
  });

  it("holds exactly when easy time is at least 80% of the week", () => {
    fc.assert(
      fc.property(fc.nat({ max: 50_000 }), fc.nat({ max: 50_000 }), (hardS, easyS) => {
        const totalS = hardS + easyS;
        expect(hardShareHolds({ hardS, totalS })).toBe(5 * hardS <= totalS);
      }),
    );
  });
});
