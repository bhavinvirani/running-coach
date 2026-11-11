import {
  DISTANCE_METERS,
  raceDistanceKeySchema,
  weekdaySchema,
  type PlanGenerationInput,
  type RaceDistanceKey,
} from "@running-coach/shared";
import fc from "fast-check";
import { addDays } from "../dates";
import { vdotFromPerformance } from "../rules/vdot";

// Test-only: the fast-check arbitraries the whole-plan properties share. Not exported from the package.

/** The time over `distanceM` that gives `vdot`, by bisection: VDOT falls as time rises. */
function timeForVdot(distanceM: number, vdot: number): number {
  let fast = 30;
  let slow = distanceM; // 60 m/min, well under any VDOT drawn
  for (let k = 0; k < 60; k += 1) {
    const mid = (fast + slow) / 2;
    if (vdotFromPerformance({ distanceM, timeS: mid }) > vdot) fast = mid;
    else slow = mid;
  }
  return Math.round((fast + slow) / 2);
}

export const distanceKeyArb = fc.constantFrom(...raceDistanceKeySchema.options);
export const mondayArb = fc
  .integer({ min: 0, max: 300 })
  .map((weeks) => addDays("2025-01-06", 7 * weeks));
// A typed-in time inside the contract's paces: 3:00 to 15:00 per km.
const recentTimeArb = fc
  .record({ distanceKey: distanceKeyArb, paceSPerKm: fc.integer({ min: 180, max: 900 }) })
  .map(({ distanceKey, paceSPerKm }) => ({
    distanceKey,
    timeS: Math.round((paceSPerKm * DISTANCE_METERS[distanceKey]) / 1000),
  }));
export const sourceArb = fc.record({
  origin: fc.constantFrom("entered" as const, "race" as const, "best_effort" as const),
  distanceKey: distanceKeyArb,
  vdot: fc.double({ min: 30, max: 65, noNaN: true }),
});

export function sourceOf(drawn: {
  origin: "entered" | "race" | "best_effort";
  distanceKey: RaceDistanceKey;
  vdot: number;
}) {
  return {
    origin: drawn.origin,
    distanceM: DISTANCE_METERS[drawn.distanceKey],
    timeS: timeForVdot(DISTANCE_METERS[drawn.distanceKey], drawn.vdot),
    activityId: null,
    date: null,
  };
}

const raceGoalArb = fc.record({
  kind: fc.constant("race" as const),
  distanceKey: distanceKeyArb,
  raceDays: fc.integer({ min: 0, max: 40 * 7 }),
  targetTimeS: fc.option(fc.integer({ min: 900, max: 6 * 3600 })),
});
const fitnessGoalArb = fc.record({
  kind: fc.constant("fitness" as const),
  distanceKey: fc.option(distanceKeyArb),
  raceDays: fc.constant(null),
  targetTimeS: fc.constant(null),
});

/** Any goal, baseline and VDOT source the contract allows, conflicts included. */
export const planInputArb: fc.Arbitrary<PlanGenerationInput> = fc
  .record({
    startDate: mondayArb,
    goal: fc.oneof(raceGoalArb, fitnessGoalArb),
    daysPerWeek: fc.integer({ min: 3, max: 6 }),
    longRunDay: fc.constantFrom(...weekdaySchema.options),
    recentTime: fc.option(recentTimeArb),
    weeklyVolumesM: fc.array(fc.nat({ max: 120_000 }), { minLength: 4, maxLength: 4 }),
    longestRunM: fc.nat({ max: 35_000 }),
    daysSinceLastRun: fc.option(fc.nat({ max: 60 })),
    source: fc.option(sourceArb),
  })
  .map((drawn) => ({
    goal: {
      kind: drawn.goal.kind,
      distanceKey: drawn.goal.distanceKey,
      raceDate: drawn.goal.raceDays === null ? null : addDays(drawn.startDate, drawn.goal.raceDays),
      targetTimeS: drawn.goal.targetTimeS,
      daysPerWeek: drawn.daysPerWeek,
      longRunDay: drawn.longRunDay,
      recentTime: drawn.recentTime,
    },
    startDate: drawn.startDate,
    baseline: {
      weeklyVolumesM: drawn.weeklyVolumesM,
      longestRunM: drawn.longestRunM,
      daysSinceLastRun: drawn.daysSinceLastRun,
    },
    vdotSource: drawn.source === null ? null : sourceOf(drawn.source),
  }));

const MIN_WEEKS: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 8,
  "10k": 8,
  half: 12,
  marathon: 18,
};
const MIN_DAYS: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 3,
  "10k": 3,
  half: 3,
  marathon: 4,
};

// Weekly volumes of a runner with history: mostly 15 to 90 km, and as often as a quarter of the
// time under 15 km, where a taper week's ceiling is close to the race week's days and 20 min runs.
const weeklyVolumesArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 15_000, max: 90_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 15_000 }) },
);

/**
 * A race plan from a runner with history, the race on any weekday `weeks` weeks into the plan, on days
 * the distance allows.
 */
function raceInputArb(weeksArb: (distanceKey: RaceDistanceKey) => fc.Arbitrary<number>) {
  return distanceKeyArb.chain((distanceKey) =>
    fc
      .record({
        startDate: mondayArb,
        weeks: weeksArb(distanceKey),
        raceWeekday: fc.integer({ min: 0, max: 6 }),
        daysPerWeek: fc.integer({ min: MIN_DAYS[distanceKey], max: 6 }),
        longRunDay: fc.constantFrom(...weekdaySchema.options),
        weeklyVolumesM: fc.oneof(
          fc.array(weeklyVolumesArb, { minLength: 4, maxLength: 4 }),
          // A runner of small weeks only: every week under 15 km.
          fc.array(fc.integer({ min: 0, max: 15_000 }), { minLength: 4, maxLength: 4 }),
        ),
        longestRunM: fc.integer({ min: 0, max: 30_000 }),
        daysSinceLastRun: fc.integer({ min: 0, max: 20 }),
        source: sourceArb,
      })
      .map((drawn): PlanGenerationInput => ({
        goal: {
          kind: "race",
          distanceKey,
          raceDate: addDays(drawn.startDate, 7 * (drawn.weeks - 1) + drawn.raceWeekday),
          targetTimeS: null,
          daysPerWeek: drawn.daysPerWeek,
          longRunDay: drawn.longRunDay,
          recentTime: null,
        },
        startDate: drawn.startDate,
        baseline: {
          weeklyVolumesM: drawn.weeklyVolumesM,
          longestRunM: drawn.longestRunM,
          daysSinceLastRun: drawn.daysSinceLastRun,
        },
        vdotSource: sourceOf(drawn.source),
      })),
  );
}

/** Race plans at least the distance's minimum, the race on every weekday: a whole taper every time. */
export const fullRaceInputArb: fc.Arbitrary<PlanGenerationInput> = raceInputArb((distanceKey) =>
  fc.integer({ min: MIN_WEEKS[distanceKey], max: MIN_WEEKS[distanceKey] + 10 }),
);

/**
 * Races 1 to 5 weeks out on every weekday: plans that start in the taper or just before it, small
 * weekly volumes among them.
 */
export const closeRaceInputArb: fc.Arbitrary<PlanGenerationInput> = raceInputArb(() =>
  fc.integer({ min: 1, max: 5 }),
);
