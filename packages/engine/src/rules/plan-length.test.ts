import { raceDistanceKeySchema, type PlanPhase } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { planLength } from "./plan-length";

const START = "2026-10-05"; // a Monday
const PHASE_ORDER: readonly PlanPhase[] = ["base", "build", "peak", "taper", "race"];

function phasesOf(spec: [PlanPhase, number][]): PlanPhase[] {
  return spec.flatMap(([phase, count]) => Array.from({ length: count }, () => phase));
}

function race(distanceKey: "5k" | "10k" | "half" | "marathon", raceDate: string) {
  return planLength({ kind: "race", distanceKey, startDate: START, raceDate });
}

describe("plan length", () => {
  it("gives a fitness goal 12 weeks of base, build and peak ending on the last Sunday", () => {
    expect(
      planLength({ kind: "fitness", distanceKey: "half", startDate: START, raceDate: null }),
    ).toEqual({
      ok: true,
      phases: phasesOf([
        ["base", 4],
        ["build", 4],
        ["peak", 4],
      ]),
      endDate: "2026-12-27",
      warning: null,
    });
  });

  it("reports race_too_soon for a race the day before the first Monday", () => {
    expect(race("10k", "2026-10-04")).toEqual({
      ok: false,
      conflict: { code: "race_too_soon", raceDate: "2026-10-04", earliestStart: START },
    });
  });

  it("makes a race on the first Monday a one-week plan: the race week, with race_date_close", () => {
    expect(race("5k", START)).toEqual({
      ok: true,
      phases: ["race"],
      endDate: START,
      warning: { code: "race_date_close", weeks: 1, minimumWeeks: 8 },
    });
  });

  it("counts a race on the 8th Sunday as 8 weeks and on the 9th Monday as 9", () => {
    const eight = race("5k", addDays(START, 55));
    const nine = race("5k", addDays(START, 56));
    expect(eight.ok && eight.phases.length).toBe(8);
    expect(nine.ok && nine.phases.length).toBe(9);
  });

  it("warns race_date_close one week under the 5K minimum and not at it or above", () => {
    expect(race("5k", addDays(START, 48))).toMatchObject({
      warning: { code: "race_date_close", weeks: 7, minimumWeeks: 8 },
    });
    expect(race("5k", addDays(START, 55))).toMatchObject({ warning: null });
    expect(race("5k", addDays(START, 62))).toMatchObject({ warning: null });
  });

  it("shapes an 8-week 10K as 1 base, 3 build, 2 peak, 1 taper and the race week", () => {
    expect(race("10k", addDays(START, 55))).toMatchObject({
      phases: phasesOf([
        ["base", 1],
        ["build", 3],
        ["peak", 2],
        ["taper", 1],
        ["race", 1],
      ]),
      endDate: addDays(START, 55),
    });
  });

  it("shapes a 12-week half as 2 base, 6 build, 2 peak, 1 taper and the race week", () => {
    expect(race("half", addDays(START, 83))).toMatchObject({
      phases: phasesOf([
        ["base", 2],
        ["build", 6],
        ["peak", 2],
        ["taper", 1],
        ["race", 1],
      ]),
      warning: null,
    });
  });

  it("shapes an 18-week marathon with a 3-week taper: 3 base, 10 build, 2 peak, 2 taper, race", () => {
    expect(race("marathon", addDays(START, 125))).toMatchObject({
      phases: phasesOf([
        ["base", 3],
        ["build", 10],
        ["peak", 2],
        ["taper", 2],
        ["race", 1],
      ]),
      warning: null,
    });
  });

  it("gives Monday, Tuesday and Wednesday races one more taper week: the week before them is in the race band", () => {
    // Every later race day's week before tapers to 70%; a Monday to Wednesday race's runs at 40%.
    for (const daysOut of [56, 57, 58]) {
      expect(race("10k", addDays(START, daysOut))).toMatchObject({
        phases: phasesOf([
          ["base", 1],
          ["build", 3],
          ["peak", 2],
          ["taper", 2],
          ["race", 1],
        ]),
        endDate: addDays(START, daysOut),
        warning: null,
      });
    }
    expect(race("10k", addDays(START, 59))).toMatchObject({
      phases: phasesOf([
        ["base", 1],
        ["build", 4],
        ["peak", 2],
        ["taper", 1],
        ["race", 1],
      ]),
    });
  });

  it("makes a marathon on the Monday of week 19 three taper weeks and the race week", () => {
    expect(race("marathon", addDays(START, 126))).toMatchObject({
      phases: phasesOf([
        ["base", 3],
        ["build", 10],
        ["peak", 2],
        ["taper", 3],
        ["race", 1],
      ]),
    });
  });

  it("makes a race on the 52nd Sunday a 52-week plan and reports race_too_far for the 53rd Monday", () => {
    const sunday = race("half", addDays(START, 363));
    expect(sunday.ok && sunday.phases.length).toBe(52);
    expect(race("half", addDays(START, 364))).toEqual({
      ok: false,
      conflict: {
        code: "race_too_far",
        raceDate: addDays(START, 364),
        latestRaceDate: addDays(START, 363),
      },
    });
  });

  it("makes a 10K 4 weeks away the taper and build weeks before it", () => {
    expect(race("10k", addDays(START, 27))).toEqual({
      ok: true,
      phases: phasesOf([
        ["build", 2],
        ["taper", 1],
        ["race", 1],
      ]),
      endDate: addDays(START, 27),
      warning: { code: "race_date_close", weeks: 4, minimumWeeks: 8 },
    });
  });

  it("makes a marathon 2 weeks away the last two taper weeks", () => {
    expect(race("marathon", addDays(START, 13))).toMatchObject({
      phases: ["taper", "race"],
      warning: { code: "race_date_close", weeks: 2, minimumWeeks: 18 },
    });
  });

  it("rejects a race goal without a race date and a fitness goal with one as programmer errors", () => {
    expect(() =>
      planLength({ kind: "race", distanceKey: "5k", startDate: START, raceDate: null }),
    ).toThrow(RangeError);
    expect(() =>
      planLength({ kind: "fitness", distanceKey: "5k", startDate: START, raceDate: START }),
    ).toThrow(RangeError);
  });

  it("orders phases base to race, ends on the race, and warns exactly under the minimum", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 400 }),
        (distanceKey, daysOut) => {
          const raceDate = addDays(START, daysOut);
          const result = race(distanceKey, raceDate);
          const weeks = Math.ceil((daysOut + 1) / 7);
          if (weeks > 52) {
            expect(result).toEqual({
              ok: false,
              conflict: { code: "race_too_far", raceDate, latestRaceDate: addDays(START, 363) },
            });
            return;
          }
          if (!result.ok) throw new Error("a race in the first 52 weeks always has a plan");
          const minimumWeeks = { "5k": 8, "10k": 8, half: 12, marathon: 18 }[distanceKey];
          // A week tapers by its Thursday: a Monday to Wednesday race's week before is in the race band.
          const taperWeeks = (distanceKey === "marathon" ? 3 : 2) + (daysOut % 7 <= 2 ? 1 : 0);
          expect(result.phases).toHaveLength(weeks);
          expect(result.phases.at(-1)).toBe("race");
          expect(result.endDate).toBe(raceDate);
          const ranks = result.phases.map((phase) => PHASE_ORDER.indexOf(phase));
          expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
          expect(result.phases.filter((phase) => phase === "taper")).toHaveLength(
            Math.min(taperWeeks, weeks) - 1,
          );
          expect(result.warning !== null).toBe(weeks < minimumWeeks);
          if (weeks >= minimumWeeks) {
            expect(result.phases.filter((phase) => phase === "peak")).toHaveLength(2);
            expect(result.phases.filter((phase) => phase === "base")).toHaveLength(
              Math.floor((weeks - taperWeeks) / 4),
            );
          } else {
            expect(result.phases.filter((phase) => phase === "base" || phase === "peak")).toEqual(
              [],
            );
          }
        },
      ),
    );
  });

  it("reports race_too_soon for every race before the first Monday", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 1, max: 400 }),
        (distanceKey, daysBefore) => {
          expect(race(distanceKey, addDays(START, -daysBefore))).toMatchObject({
            ok: false,
            conflict: { code: "race_too_soon" },
          });
        },
      ),
    );
  });
});
