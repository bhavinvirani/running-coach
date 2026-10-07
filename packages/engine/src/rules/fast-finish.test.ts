import { planPhaseSchema, sessionStepsSchema, type PlanPaces } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fastFinishM, fastFinishWeeks, longRunSteps, shorterFinishM } from "./fast-finish";
import { sessionTarget } from "./session-target";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 },
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 },
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 224 },
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};

describe("fast finish", () => {
  it("runs the last 20% of the long run at marathon pace in whole 500 m: 1.0 km from a 5 km long run, none under it", () => {
    expect(fastFinishM(4999)).toBe(0);
    expect(fastFinishM(5000)).toBe(1000);
    expect(fastFinishM(7499)).toBe(1000);
    expect(fastFinishM(7500)).toBe(1500);
    expect(fastFinishM(16_800)).toBe(3000);
  });

  it("finishes 5.0 km at most: 25 km and longer long runs", () => {
    expect(fastFinishM(24_999)).toBe(4500);
    expect(fastFinishM(25_000)).toBe(5000);
    expect(fastFinishM(32_000)).toBe(5000);
  });

  it("cuts a finish 500 m at a time and drops it under 1 km", () => {
    expect(shorterFinishM(3000)).toBe(2500);
    expect(shorterFinishM(1500)).toBe(1000);
    expect(shorterFinishM(1000)).toBe(0);
  });

  it("carves the finish out of the long run's distance: 12.0 km easy and 3.0 km at marathon pace make 15.0 km", () => {
    const steps = longRunSteps({ distanceM: 15_000, finishM: 3000 });
    expect(steps).toEqual([
      { kind: "run", zone: "easy", distanceM: 12_000, durationS: null },
      { kind: "run", zone: "marathon", distanceM: 3000, durationS: null },
    ]);
    expect(sessionTarget(steps, PACES)).toMatchObject({ distanceM: 15_000, zone: "easy" });
    expect(longRunSteps({ distanceM: 15_000, finishM: 0 })).toEqual([
      { kind: "run", zone: "easy", distanceM: 15_000, durationS: null },
    ]);
  });

  it("gives every second build or peak week that is not a down week a finish, the first of them included", () => {
    expect(
      fastFinishWeeks([
        { phase: "base", down: false },
        { phase: "base", down: false },
        { phase: "base", down: true },
        { phase: "build", down: false },
        { phase: "build", down: false },
        { phase: "build", down: false },
        { phase: "build", down: true },
        { phase: "build", down: false },
        { phase: "peak", down: false },
        { phase: "peak", down: false },
      ]),
    ).toEqual([false, false, false, true, false, true, false, false, true, false]);
  });

  it("never finishes a base, down or taper week", () => {
    expect(
      fastFinishWeeks([
        { phase: "base", down: false },
        { phase: "peak", down: true },
        { phase: "taper", down: false },
        { phase: "race", down: false },
      ]),
    ).toEqual([false, false, false, false]);
  });

  it("keeps the finish within 20% of the long run and 1 to 5 km, and the long run's distance as given", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60_000 }), (longM) => {
        const finishM = fastFinishM(longM);
        if (finishM !== 0) {
          expect(finishM % 500).toBe(0);
          expect(finishM).toBeGreaterThanOrEqual(1000);
          expect(finishM).toBeLessThanOrEqual(Math.min(5000, 0.2 * longM));
        }
        const steps = longRunSteps({ distanceM: longM, finishM });
        expect(sessionStepsSchema.parse(steps)).toEqual(steps);
        expect(sessionTarget(steps, PACES).distanceM).toBe(longM);
      }),
    );
  });

  it("gives at most every other build or peak week a finish, never two in a row of them", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ phase: fc.constantFrom(...planPhaseSchema.options), down: fc.boolean() }),
          { maxLength: 52 },
        ),
        (weeks) => {
          const finishes = fastFinishWeeks(weeks);
          expect(finishes).toHaveLength(weeks.length);
          const counted = weeks
            .map((week, k) => ({ ...week, finish: finishes[k]! }))
            .filter((week) => !week.down && (week.phase === "build" || week.phase === "peak"));
          expect(finishes.filter(Boolean)).toHaveLength(Math.ceil(counted.length / 2));
          counted.forEach((week, k) => expect(week.finish).toBe(k % 2 === 0));
        },
      ),
    );
  });
});
