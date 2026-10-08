import type { GeneratedSession, PlanGenerationInput, SessionSteps } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { longestRunSeedM, maxRunM } from "../rules/long-run";
import { bandMidpointSPerKm, sessionTarget } from "../rules/session-target";
import { minRunDistanceM } from "../rules/week-fill";
import { buildTrainingWeek, sizeWeek, weekRunCaps, type PlanContext } from "./build-week";
import { generatePlan } from "./generate";

const START = "2026-10-05"; // a Monday

/** The context generatePlan builds its weeks in, from the paces of the plan it makes. */
function contextOf(of: PlanGenerationInput): PlanContext {
  const result = generatePlan(of);
  if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.conflict)}`);
  const easyPaceSPerKm = bandMidpointSPerKm(result.plan.paces.easy);
  return {
    distanceKey: of.goal.distanceKey ?? "10k",
    daysPerWeek: of.goal.daysPerWeek,
    longRunDay: of.goal.longRunDay,
    raceDate: of.goal.raceDate,
    paces: result.plan.paces,
    easyPaceSPerKm,
    minRunM: minRunDistanceM(easyPaceSPerKm),
    baselineLongestM: of.baseline.longestRunM,
  };
}

function fiveK(daysPerWeek: number, longestRunM: number): PlanGenerationInput {
  return {
    goal: {
      kind: "race",
      distanceKey: "5k",
      raceDate: addDays(START, 27),
      targetTimeS: null,
      daysPerWeek,
      longRunDay: "sun",
      recentTime: null,
    },
    startDate: START,
    baseline: {
      weeklyVolumesM: [30_000, 30_000, 30_000, 30_000],
      longestRunM,
      daysSinceLastRun: 2,
    },
    vdotSource: { origin: "entered", distanceM: 5000, timeS: 1500, activityId: null, date: null },
  };
}

function weekOne(of: PlanGenerationInput, phase: "base" | "build", targetM: number) {
  const ctx = contextOf(of);
  return buildTrainingWeek(ctx, {
    number: 1,
    phase,
    weekStart: of.startDate,
    targetM,
    maxRunM: maxRunM(longestRunSeedM(of.baseline.longestRunM)),
    lastHardDate: null,
    fastFinish: false,
  }).week;
}

describe("build week", () => {
  it("keeps the long run the week's longest run: a 3-day week's one-block tempo that would pass it runs easy", () => {
    // A base week of 15 km: 20 min on the easy day would leave a 5763 m long run beside a 5798 m tempo.
    // The tempo's one block is its last rep, so the tempo runs easy and the long run keeps 6136 m. The two
    // easy runs split the 8864 m left 58 to 42, Thursday first in an odd week; 500 m steps would take
    // Thursday past 85% of the long run (5215 m), so the week stays unrounded.
    const fitness: PlanGenerationInput = {
      goal: {
        kind: "fitness",
        distanceKey: "5k",
        raceDate: null,
        targetTimeS: null,
        daysPerWeek: 3,
        longRunDay: "mon",
        recentTime: null,
      },
      startDate: "2025-01-06",
      baseline: { weeklyVolumesM: [0, 0, 0, 0], longestRunM: 6136, daysSinceLastRun: null },
      vdotSource: { origin: "entered", distanceM: 5000, timeS: 1317, activityId: null, date: null },
    };
    const week = weekOne(fitness, "base", 15_000);
    expect(week.distanceM).toBe(15_000);
    expect(week.sessions.map((session) => [session.type, session.target.distanceM])).toEqual([
      ["long", 6136],
      ["easy", 5142],
      ["easy", 3722],
    ]);
  });

  it("runs a build week's second quality session easy when the long run would be 1 m under the longest session, not 1 m over", () => {
    // 4 days of a 5K build week: intervals, a tempo and 20 min on the easy day leave the long run exactly
    // the 6321 m intervals at 21 595 m.
    const of = fiveK(4, 15_000);
    const sized = (weekM: number) =>
      Object.fromEntries(
        weekOne(of, "build", weekM).sessions.map((session) => [
          session.type,
          session.target.distanceM,
        ]),
      );
    const over = sized(21_596);
    expect(Object.keys(over).sort()).toEqual(["easy", "intervals", "long", "tempo"]);
    expect(over.long! - over.intervals!).toBe(1);
    expect(sized(21_595).long).toBe(over.intervals);
    expect(weekOne(of, "build", 21_594).sessions.map((session) => session.type)).toEqual([
      "intervals",
      "easy",
      "easy",
      "long",
    ]);
  });

  it("gives the tempo's day to an easy run once the long run is down to 20 min: a 20 km build week on 5 days", () => {
    // With intervals and a tempo, the long run would have to drop under 20 min for 20 min on each
    // easy day, so the tempo goes, its day an easy run, and the long run takes what is left.
    const of = fiveK(5, 8000);
    const { minRunM } = contextOf(of);
    const week = weekOne(of, "build", 20_000);
    expect(week.sessions.map((session) => [session.date, session.type])).toEqual([
      [addDays(START, 1), "intervals"],
      [addDays(START, 2), "easy"],
      [addDays(START, 3), "easy"],
      [addDays(START, 4), "easy"],
      [addDays(START, 6), "long"],
    ]);
    const intervalsM = week.sessions[0]!.target.distanceM;
    expect(week.sessions.map((session) => session.target.distanceM)).toEqual([
      intervalsM,
      minRunM,
      minRunM,
      minRunM,
      20_000 - intervalsM - 3 * minRunM,
    ]);
  });

  it("caps the long run at what the fixed sessions leave of the week, and runs none where that is under 20 min", () => {
    // A taper week holding a 4500 m day of the race week's: a 20 min long run fits beside it only
    // when the week holds 20 min more.
    const ctx = contextOf(fiveK(4, 5000));
    const steps: SessionSteps = [{ kind: "run", zone: "easy", distanceM: 4500, durationS: null }];
    const fixed: GeneratedSession[] = [
      { date: addDays(START, 5), type: "easy", target: sessionTarget(steps, ctx.paces), steps },
    ];
    const sized = (targetM: number) =>
      sizeWeek(ctx, {
        slots: { long: addDays(START, 2), quality: [], easy: [] },
        fixed,
        keepsBaselineLongest: false,
        targetM,
        maxRunM: 20_000,
        weekNumber: 1,
        fastFinish: false,
      }).map((session) => [session.type, session.target.distanceM]);
    expect(sized(4500 + ctx.minRunM - 1)).toEqual([]);
    expect(sized(4500 + ctx.minRunM)).toEqual([["long", ctx.minRunM]]);
  });

  it("drops the long run where its cap by days to the race is under 20 min, and holds no run to that cap", () => {
    // A Thursday 5K 11 days after the week's Sunday caps its long run at 70% of the 5 km seed, 3500
    // m: a long run of 20 min fits it at 3500 m, not at 3501 m.
    const ctx = contextOf(fiveK(4, 0));
    const weekStart = addDays(START, 7);
    const caps = (raceDate: string, minRunM: number) =>
      weekRunCaps(
        { ...ctx, raceDate, minRunM },
        { weekStart, longRunsBeforeM: [], seedM: 5000, runCapM: 9000 },
      );
    const thursday = addDays(weekStart, 14 + 3);
    expect(caps(thursday, 3500)).toEqual({ maxRunM: 3500, longRun: true });
    expect(caps(thursday, 3501)).toEqual({ maxRunM: 9000, longRun: false });
    // 14 days out a 5K's long run has no cap by days.
    expect(caps(addDays(thursday, 3), 9000)).toEqual({ maxRunM: 9000, longRun: true });
  });
});
