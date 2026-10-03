import {
  DISTANCE_METERS,
  raceDistanceKeySchema,
  type PlanPhase,
  type RaceDistanceKey,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildTrainingWeek, type PlanContext } from "../plan/build-week";
import { longestRunSeedM, maxRunM } from "./long-run";
import { neededWeeklyM, type NeededWeekInput } from "./needed-volume";
import { predictTimeS, racePace } from "./prediction";
import { QUALITY_SESSION_TYPE } from "./quality";
import { bandMidpointSPerKm } from "./session-target";
import { pacesFromVdot, roundVdot, vdotFromPerformance } from "./vdot";
import { minRunDistanceM } from "./week-fill";

const MONDAY = "2026-10-05";
const QUALITY_TYPES: ReadonlySet<string> = new Set(Object.values(QUALITY_SESSION_TYPE));

interface Runner {
  distanceKey: RaceDistanceKey;
  daysPerWeek: number;
  /** The 5K time the paces come from. */
  fiveKTimeS: number;
  baselineLongestM: number;
}

/** The context generatePlan sizes week 1 in: paces from the runner's 5K, no race date. */
function contextOf({
  distanceKey,
  daysPerWeek,
  fiveKTimeS,
  baselineLongestM,
}: Runner): PlanContext {
  const training = pacesFromVdot(
    roundVdot(vdotFromPerformance({ distanceM: 5000, timeS: fiveKTimeS })),
  );
  const distanceM = DISTANCE_METERS[distanceKey];
  const predictedTimeS = predictTimeS({
    fromDistanceM: 5000,
    fromTimeS: fiveKTimeS,
    toDistanceM: distanceM,
  });
  const race = racePace({ distanceM, predictedTimeS, targetTimeS: null });
  const easyPaceSPerKm = bandMidpointSPerKm(training.easy);
  return {
    distanceKey,
    daysPerWeek,
    longRunDay: "sun",
    raceDate: null,
    paces: { ...training, race: race.band },
    easyPaceSPerKm,
    minRunM: minRunDistanceM(easyPaceSPerKm),
    baselineLongestM,
  };
}

/** Week 1 as generatePlan measures it: no run over 110% of the runner's longest, 5 km at least. */
function weekOneOf(phase: PlanPhase, baselineLongestM: number): NeededWeekInput {
  return { phase, weekStart: MONDAY, maxRunM: maxRunM(longestRunSeedM(baselineLongestM)) };
}

/**
 * The oracle, from the rule's definition: a week of this volume, as the builder sizes it, holds the
 * sessions when it runs on every day asked for, each run at least 20 min, and (withQuality) keeps every
 * quality session its days lay out.
 */
function holds(
  ctx: PlanContext,
  week: NeededWeekInput,
  volumeM: number,
  withQuality: boolean,
): boolean {
  const built = buildTrainingWeek(ctx, {
    number: 1,
    phase: week.phase,
    weekStart: week.weekStart,
    targetM: volumeM,
    maxRunM: week.maxRunM,
    lastHardDate: null,
  });
  const { sessions } = built.week;
  const quality = sessions.filter((session) => QUALITY_TYPES.has(session.type));
  return (
    sessions.length === ctx.daysPerWeek &&
    sessions.every((session) => session.target.distanceM >= ctx.minRunM) &&
    (!withQuality || quality.length === built.slots.quality.length)
  );
}

/** The largest week the search looks at: twice every run at its cap, or at 20 min if the cap is less. */
const largestSearchedM = (ctx: PlanContext, week: NeededWeekInput) =>
  2 * ctx.daysPerWeek * Math.max(week.maxRunM, ctx.minRunM);

const runner = (daysPerWeek: number): Runner => ({
  distanceKey: "10k",
  daysPerWeek,
  fiveKTimeS: 1500,
  baselineLongestM: 10_000,
});

const runnerArb = fc.record({
  distanceKey: fc.constantFrom(...raceDistanceKeySchema.options),
  daysPerWeek: fc.integer({ min: 3, max: 6 }),
  // 15:00 to 45:00 for 5K: every pace a plan is made at.
  fiveKTimeS: fc.integer({ min: 900, max: 2700 }),
  baselineLongestM: fc.nat({ max: 35_000 }),
});
const phaseArb = fc.constantFrom<PlanPhase>("base", "build", "peak", "taper");
// A share of a range, to draw weeks anywhere between two volumes.
const shareArb = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

// Contexts where a search that grew the week by 25% a step stepped over the smallest week that holds
// the sessions (or every week that holds the quality sessions, at 6 days a 15:00 5K, base, 9414 m).
// Each minimum was found by trying every whole metre from 20 min a day up.
const OVERSHOT: readonly (readonly [RaceDistanceKey, number, number, PlanPhase, number, number])[] =
  [
    ["5k", 903, 21_647, "peak", 6, 49_880],
    ["5k", 2071, 6266, "build", 6, 19_873],
    ["marathon", 1297, 25_099, "build", 4, 24_686],
    ["5k", 900, 9414, "base", 6, 39_702],
    ["5k", 2243, 7544, "base", 6, 16_888],
    ["10k", 905, 23_281, "build", 6, 48_192],
    ["marathon", 2388, 6572, "build", 6, 17_818],
    ["half", 1778, 34_699, "base", 3, 9901],
    ["10k", 2690, 8767, "peak", 5, 13_901],
  ];

describe("needed volume", () => {
  it("returns the smallest whole-metre week that holds week 1's sessions: one metre under it does not", () => {
    const ctx = contextOf(runner(5));
    const week = weekOneOf("build", 10_000);
    const neededM = neededWeeklyM(ctx, week);
    expect(Number.isInteger(neededM)).toBe(true);
    expect(holds(ctx, week, neededM, true)).toBe(true);
    expect(holds(ctx, week, neededM - 1, true)).toBe(false);
  });

  it.each(OVERSHOT)(
    "returns the true minimum where growing steps overshot it: %s at %i s, longest %i m, %s, %i days",
    (distanceKey, fiveKTimeS, baselineLongestM, phase, daysPerWeek, minimumM) => {
      const ctx = contextOf({ distanceKey, daysPerWeek, fiveKTimeS, baselineLongestM });
      const week = weekOneOf(phase, baselineLongestM);
      expect(neededWeeklyM(ctx, week)).toBe(minimumM);
      expect(holds(ctx, week, minimumM, true)).toBe(true);
      expect(holds(ctx, week, minimumM - 1, true)).toBe(false);
    },
  );

  it("needs at least 20 min on every day asked for", () => {
    for (const days of [3, 4, 5, 6]) {
      const ctx = contextOf(runner(days));
      expect(neededWeeklyM(ctx, weekOneOf("base", 10_000))).toBeGreaterThanOrEqual(
        days * ctx.minRunM,
      );
    }
  });

  it("is monotonic in days: 3 to 6 days a week never need less as days are added", () => {
    const needed = [3, 4, 5, 6].map((days) =>
      neededWeeklyM(contextOf(runner(days)), weekOneOf("build", 10_000)),
    );
    expect(needed).toEqual([...needed].sort((a, b) => a - b));
  });

  it("measures a plan that starts in the taper on a taper week", () => {
    const ctx = contextOf(runner(4));
    const week = weekOneOf("taper", 10_000);
    const neededM = neededWeeklyM(ctx, week);
    expect(holds(ctx, week, neededM, true)).toBe(true);
    expect(holds(ctx, week, neededM - 1, true)).toBe(false);
  });

  it("is deterministic: the same context gives the same metres", () => {
    const ctx = contextOf(runner(4));
    const week = weekOneOf("peak", 10_000);
    expect(neededWeeklyM(ctx, week)).toBe(neededWeeklyM(ctx, week));
  });

  it("with a run cap that keeps the quality sessions out at any volume, returns the smallest week the days alone need", () => {
    // No recent long run, so no run over 5500 m. At 4 days the long run takes at most 30% of the week
    // and the tempo (25 min easy around a block of 10% of the week) must stay under it and the cap:
    // 4000 m + 10% <= 30% needs 20 km, 4000 m + 10% <= 5500 m allows 15 km at most.
    const ctx = contextOf({
      distanceKey: "5k",
      daysPerWeek: 4,
      fiveKTimeS: 1421,
      baselineLongestM: 0,
    });
    const week = weekOneOf("base", 0);
    const neededM = neededWeeklyM(ctx, week);
    for (let volumeM = 4 * ctx.minRunM; volumeM <= largestSearchedM(ctx, week); volumeM += 100) {
      expect(holds(ctx, week, volumeM, true)).toBe(false);
    }
    expect(neededM).toBe(4 * ctx.minRunM);
    expect(holds(ctx, week, neededM, false)).toBe(true);
    expect(holds(ctx, week, neededM - 1, false)).toBe(false);
  });

  it("is not monotonic in days across that boundary: 3 days that hold the tempo need more than 4 that cannot", () => {
    // At 3 days the long run may take 40% of the week, so the same tempo fits from about 13.8 km.
    const of: Runner = { distanceKey: "5k", daysPerWeek: 3, fiveKTimeS: 1421, baselineLongestM: 0 };
    const week = weekOneOf("base", 0);
    const threeDays = contextOf(of);
    const fourDays = contextOf({ ...of, daysPerWeek: 4 });
    const threeDaysM = neededWeeklyM(threeDays, week);
    expect(holds(threeDays, week, threeDaysM, true)).toBe(true);
    expect(holds(fourDays, week, neededWeeklyM(fourDays, week), true)).toBe(false);
    expect(neededWeeklyM(fourDays, week)).toBeLessThan(threeDaysM);
  });

  it("with a run cap under 20 min no week holds the days: returns the largest week searched", () => {
    const ctx = contextOf(runner(4));
    const week: NeededWeekInput = { phase: "base", weekStart: MONDAY, maxRunM: ctx.minRunM - 1 };
    expect(neededWeeklyM(ctx, week)).toBe(2 * 4 * ctx.minRunM);
    expect(holds(ctx, week, 2 * 4 * ctx.minRunM, false)).toBe(false);
  });

  it("over days 3 to 6 and paces, returns a week that holds the sessions while one metre less does not", () => {
    fc.assert(
      fc.property(runnerArb, phaseArb, (of, phase) => {
        const ctx = contextOf(of);
        const week = weekOneOf(phase, of.baselineLongestM);
        const neededM = neededWeeklyM(ctx, week);
        const withQuality = holds(ctx, week, neededM, true);
        expect(Number.isInteger(neededM)).toBe(true);
        // The days alone only when even the largest week searched cannot hold the quality sessions.
        expect(withQuality || !holds(ctx, week, largestSearchedM(ctx, week), true)).toBe(true);
        expect(holds(ctx, week, neededM, withQuality)).toBe(true);
        expect(holds(ctx, week, neededM - 1, withQuality)).toBe(false);
      }),
    );
  });

  it("over days 3 to 6 and paces, no smaller week holds the sessions, and no week at all the quality ones when it returns the days alone", () => {
    fc.assert(
      fc.property(runnerArb, phaseArb, shareArb, (of, phase, share) => {
        const ctx = contextOf(of);
        const week = weekOneOf(phase, of.baselineLongestM);
        const neededM = neededWeeklyM(ctx, week);
        const withQuality = holds(ctx, week, neededM, true);
        const fewestM = ctx.daysPerWeek * ctx.minRunM;
        const belowM = fewestM + Math.floor(share * (neededM - fewestM));
        expect(belowM === neededM || !holds(ctx, week, belowM, withQuality)).toBe(true);
        const anyM = fewestM + Math.floor(share * (largestSearchedM(ctx, week) - fewestM));
        expect(withQuality || !holds(ctx, week, anyM, true)).toBe(true);
      }),
    );
  });

  it("over days 3 to 6 and paces, a day more never needs less when both day counts hold their quality sessions", () => {
    fc.assert(
      fc.property(runnerArb, phaseArb, (of, phase) => {
        const week = weekOneOf(phase, of.baselineLongestM);
        const contexts = [3, 4, 5, 6].map((daysPerWeek) => contextOf({ ...of, daysPerWeek }));
        const needed = contexts.map((ctx) => neededWeeklyM(ctx, week));
        const withQuality = contexts.map((ctx, k) => holds(ctx, week, needed[k]!, true));
        for (let k = 1; k < contexts.length; k += 1) {
          if (withQuality[k - 1]! && withQuality[k]!) {
            expect(needed[k]).toBeGreaterThanOrEqual(needed[k - 1]!);
          }
        }
      }),
    );
    // Four searches through the week builder per runner: a few seconds in all.
  }, 30_000);
});
