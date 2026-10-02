import {
  DISTANCE_METERS,
  planGenerationResultSchema,
  raceDistanceKeySchema,
  weekdaySchema,
  type GeneratedPlan,
  type GeneratedSession,
  type PlanGenerationInput,
  type PlanPaces,
  type RaceDistanceKey,
  type SessionSteps,
  type Step,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, weekdayOf } from "../dates";
import { vdotFromPerformance } from "../rules/vdot";
import { fillWeek } from "../rules/week-fill";
import { generatePlan } from "./generate";

const START = "2026-10-05"; // a Monday
const QUALITY_TYPES = new Set(["intervals", "tempo", "race_practice"]);
const HARD_TYPES = new Set(["long", "intervals", "tempo", "race_practice", "race"]);
const HARD_ZONES = new Set(["threshold", "interval", "repetition", "race"]);
const WORK_CAP = { threshold: 0.1, interval: 0.08, repetition: 0.05, race: 0.1 } as const;
const MIN_WEEKS = { "5k": 8, "10k": 8, half: 12, marathon: 18 } as const;
const EPS = 1e-9;

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

function input(overrides: {
  goal?: Partial<PlanGenerationInput["goal"]>;
  baseline?: Partial<PlanGenerationInput["baseline"]>;
  vdotSource?: PlanGenerationInput["vdotSource"];
  startDate?: string;
}): PlanGenerationInput {
  return {
    goal: {
      kind: "race",
      distanceKey: "10k",
      raceDate: addDays(START, 7 * 12 - 1),
      targetTimeS: null,
      daysPerWeek: 4,
      longRunDay: "sun",
      recentTime: null,
      ...overrides.goal,
    },
    startDate: overrides.startDate ?? START,
    baseline: {
      weeklyVolumesM: [30_000, 32_000, 28_000, 30_000],
      longestRunM: 12_000,
      daysSinceLastRun: 2,
      ...overrides.baseline,
    },
    vdotSource:
      overrides.vdotSource === undefined
        ? { origin: "entered", distanceM: 5000, timeS: 1500, activityId: null, date: null }
        : overrides.vdotSource,
  };
}

function plan(of: PlanGenerationInput): GeneratedPlan {
  const result = generatePlan(of);
  if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.conflict)}`);
  return result.plan;
}

const midpoint = (paces: PlanPaces, zone: Step["zone"]) =>
  (paces[zone].fastSPerKm + paces[zone].slowSPerKm) / 2;

function counted(steps: SessionSteps): { step: Step; times: number }[] {
  return steps.flatMap((item) =>
    "repeat" in item
      ? item.steps.map((step) => ({ step, times: item.repeat }))
      : [{ step: item, times: 1 }],
  );
}

function stepSeconds(step: Step, paces: PlanPaces): number {
  return step.durationS ?? Math.round((step.distanceM! * midpoint(paces, step.zone)) / 1000);
}

function stepMeters(step: Step, paces: PlanPaces): number {
  return step.distanceM ?? Math.round((step.durationS! * 1000) / midpoint(paces, step.zone));
}

/** A quality session's meters before fillWeek padded its warmup. */
function unpaddedM(session: GeneratedSession, paces: PlanPaces): number {
  const warmup = session.steps[0] as Step;
  const padM =
    warmup.distanceM === null
      ? 0
      : warmup.distanceM - Math.round((900 * 1000) / midpoint(paces, "easy"));
  return session.target.distanceM - padM;
}

/**
 * Whether a week of `weekM` holds the baseline's longest run as its long run: 20 min on every other
 * day, and every meter placed beside it by fillWeek's rules with this week's quality sessions.
 */
function holdsLongRun({
  weekM,
  longM,
  qualityM,
  daysPerWeek,
  minRunM,
}: {
  weekM: number;
  longM: number;
  qualityM: readonly number[];
  daysPerWeek: number;
  minRunM: number;
}): boolean {
  if (weekM - (daysPerWeek - 1) * minRunM < longM) return false;
  const restM = weekM - longM;
  const fill = fillWeek({
    restM,
    capM: longM,
    qualityM,
    easySlots: daysPerWeek - 1 - qualityM.length,
    minRunM,
  });
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  return sum(qualityM) + sum(fill.qualityPadM) + sum(fill.easyRunsM) === restM;
}

function numbersIn(value: unknown, path = ""): [string, number][] {
  if (typeof value === "number") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, k) => numbersIn(item, `${path}[${k}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => numbersIn(item, `${path}.${key}`));
  }
  return [];
}

// --- arbitraries ----------------------------------------------------------------------------------

const distanceKeyArb = fc.constantFrom(...raceDistanceKeySchema.options);
const mondayArb = fc.integer({ min: 0, max: 300 }).map((weeks) => addDays("2025-01-06", 7 * weeks));

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

const inputArb: fc.Arbitrary<PlanGenerationInput> = fc
  .record({
    startDate: mondayArb,
    goal: fc.oneof(raceGoalArb, fitnessGoalArb),
    daysPerWeek: fc.integer({ min: 3, max: 6 }),
    longRunDay: fc.constantFrom(...weekdaySchema.options),
    recentTime: fc.option(
      fc.record({ distanceKey: distanceKeyArb, timeS: fc.integer({ min: 900, max: 20_000 }) }),
    ),
    weeklyVolumesM: fc.array(fc.nat({ max: 120_000 }), { minLength: 4, maxLength: 4 }),
    longestRunM: fc.nat({ max: 35_000 }),
    daysSinceLastRun: fc.option(fc.nat({ max: 60 })),
    source: fc.option(
      fc.record({
        origin: fc.constantFrom("entered" as const, "race" as const, "best_effort" as const),
        distanceKey: distanceKeyArb,
        vdot: fc.double({ min: 30, max: 65, noNaN: true }),
      }),
    ),
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
    vdotSource:
      drawn.source === null
        ? null
        : {
            origin: drawn.source.origin,
            distanceM: DISTANCE_METERS[drawn.source.distanceKey],
            timeS: timeForVdot(DISTANCE_METERS[drawn.source.distanceKey], drawn.source.vdot),
            activityId: null,
            date: null,
          },
  }));

// --- the whole-plan property ----------------------------------------------------------------------

function assertPlanKeepsEveryRule(
  of: PlanGenerationInput,
  result: ReturnType<typeof generatePlan>,
): void {
  expect(planGenerationResultSchema.parse(result)).toEqual(result);
  if (!result.ok) return;
  const { goal, baseline } = of;
  const { paces, weeks } = result.plan;
  const share = goal.daysPerWeek === 3 ? 0.4 : 0.3;
  const distanceKey: RaceDistanceKey = goal.distanceKey ?? "10k";
  const minRunM = Math.ceil((1200 * 1000) / midpoint(paces, "easy"));
  const longRunMaxM = Math.floor((9000 * 1000) / midpoint(paces, "easy"));

  numbersIn(result.plan)
    .filter(([path]) => path !== ".vdot")
    .forEach(([path, value]) => expect(Number.isInteger(value), path).toBe(true));

  expect(result.plan.startDate).toBe(of.startDate);
  expect(result.plan.endDate).toBe(goal.raceDate ?? addDays(of.startDate, 83));

  const sessions = weeks.flatMap((week) => week.sessions);
  const races = sessions.filter((session) => session.type === "race");
  expect(races.map((session) => session.date)).toEqual(
    goal.raceDate === null ? [] : [goal.raceDate],
  );

  const seedM = Math.max(baseline.longestRunM, 5000);
  const longestByWeek: number[] = [];
  let previousNonDownM: number | null = null;

  weeks.forEach((week, k) => {
    expect(week.number).toBe(k + 1);
    expect(week.startDate).toBe(addDays(of.startDate, 7 * k));
    expect(weekdayOf(week.startDate)).toBe("mon");
    expect(week.distanceM).toBe(
      week.sessions.reduce((sum, session) => sum + session.target.distanceM, 0),
    );
    expect(week.sessions.length).toBeLessThanOrEqual(goal.daysPerWeek);

    const dates = week.sessions.map((session) => session.date);
    dates
      .slice(1)
      .forEach((date, j) => expect(daysBetween(dates[j]!, date)).toBeGreaterThanOrEqual(1));
    for (const date of dates) {
      expect(daysBetween(week.startDate, date)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(week.startDate, date)).toBeLessThanOrEqual(6);
      expect(daysBetween(result.plan.startDate, date)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(date, result.plan.endDate)).toBeGreaterThanOrEqual(0);
    }

    // Targets add up from the steps at each zone's midpoint pace.
    for (const session of week.sessions) {
      const steps = counted(session.steps);
      expect(session.target.distanceM).toBe(
        steps.reduce((sum, { step, times }) => sum + times * stepMeters(step, paces), 0),
      );
      expect(session.target.durationS).toBe(
        steps.reduce((sum, { step, times }) => sum + times * stepSeconds(step, paces), 0),
      );
      expect(session.target.distanceM).toBeGreaterThan(0);
    }

    const raceM = week.sessions
      .filter((s) => s.type === "race")
      .reduce((sum, s) => sum + s.target.distanceM, 0);
    const runningM = week.distanceM - raceM;
    const previous = weeks[k - 1];
    const isPreTaper = week.phase === "base" || week.phase === "build" || week.phase === "peak";
    if (isPreTaper && week.number % 4 !== 0) {
      if (previousNonDownM !== null)
        expect(week.distanceM).toBeLessThanOrEqual(Math.floor(previousNonDownM * 1.1));
      previousNonDownM = week.distanceM;
    } else if (previous !== undefined) {
      // Down weeks, taper weeks and the race week's running never rise over the week before.
      expect(runningM).toBeLessThanOrEqual(previous.distanceM);
    }

    // No run over 110% of the longest of the last 4 weeks, the baseline standing in before the plan.
    const window = longestByWeek.slice(-4);
    const longestRecent = Math.max(...window, window.length < 4 ? seedM : 0);
    const runs = week.sessions.filter((session) => session.type !== "race");
    for (const run of runs)
      expect(run.target.distanceM).toBeLessThanOrEqual(Math.floor(longestRecent * 1.1));
    longestByWeek.push(Math.max(0, ...runs.map((run) => run.target.distanceM)));

    // The long run: on its day outside the race week, within its share of the week and 150 min.
    const longs = week.sessions.filter((session) => session.type === "long");
    if (week.phase === "race") {
      expect(longs).toEqual([]);
    } else {
      const longDate = addDays(week.startDate, weekdaySchema.options.indexOf(goal.longRunDay));
      const dayBeforeRace = goal.raceDate !== null && addDays(goal.raceDate, -1) === longDate;
      expect(longs.map((session) => session.date)).toEqual(dayBeforeRace ? [] : [longDate]);
    }
    // The share keeps the long run from growing past it; it never cuts the baseline's longest run in
    // base, build and peak weeks that can hold it (150 min and 110% of the recent longest allowing).
    for (const long of longs) {
      expect(long.target.distanceM).toBeLessThanOrEqual(
        isPreTaper
          ? Math.max(share * week.distanceM, baseline.longestRunM) + EPS
          : share * week.distanceM + EPS,
      );
      expect(long.target.durationS).toBeLessThanOrEqual(9000);
      const canHoldBaselineLongest =
        longRunMaxM >= baseline.longestRunM &&
        Math.floor(longestRecent * 1.1) >= baseline.longestRunM &&
        holdsLongRun({
          weekM: week.distanceM,
          longM: baseline.longestRunM,
          qualityM: week.sessions
            .filter((session) => QUALITY_TYPES.has(session.type))
            .map((session) => unpaddedM(session, paces)),
          daysPerWeek: goal.daysPerWeek,
          minRunM,
        });
      if (isPreTaper && canHoldBaselineLongest) {
        expect(long.target.distanceM).toBeGreaterThanOrEqual(baseline.longestRunM);
      }
    }

    // At least 80% of the week's time easy.
    const totalS = week.sessions.reduce((sum, session) => sum + session.target.durationS, 0);
    const hardS = week.sessions
      .flatMap((session) => counted(session.steps))
      .filter(({ step }) => step.kind === "work" && HARD_ZONES.has(step.zone))
      .reduce((sum, { step, times }) => sum + times * stepSeconds(step, paces), 0);
    expect(hardS).toBeLessThanOrEqual(0.2 * totalS + EPS);

    // At most 2 quality sessions, 1 at 3 days; work within T 10%, I 8%, R 5%, race pace 10%.
    const quality = week.sessions.filter((session) => QUALITY_TYPES.has(session.type));
    expect(quality.length).toBeLessThanOrEqual(goal.daysPerWeek === 3 ? 1 : 2);
    for (const session of quality) {
      const work = counted(session.steps).filter(({ step }) => step.kind === "work");
      expect(work.length).toBeGreaterThan(0);
      for (const zone of new Set(work.map(({ step }) => step.zone))) {
        const workM = work
          .filter(({ step }) => step.zone === zone)
          .reduce((sum, { step, times }) => sum + times * stepMeters(step, paces), 0);
        expect(workM).toBeLessThanOrEqual(
          WORK_CAP[zone as keyof typeof WORK_CAP] * week.distanceM + EPS,
        );
      }
    }
  });

  // 48 h between hard days, across week boundaries too.
  const hardDates = sessions
    .filter((session) => HARD_TYPES.has(session.type))
    .map((session) => session.date);
  hardDates
    .slice(1)
    .forEach((date, k) => expect(daysBetween(hardDates[k]!, date)).toBeGreaterThanOrEqual(2));

  // A full taper cuts the race week's running to 40-60% of the peak when the race leaves 3 days to run.
  const raceWeek = weeks.at(-1)!;
  if (
    goal.kind === "race" &&
    weeks.length >= MIN_WEEKS[distanceKey] &&
    ["fri", "sat", "sun"].includes(weekdayOf(goal.raceDate!))
  ) {
    const peakM = Math.max(
      ...weeks.filter((week) => week.phase === "peak").map((week) => week.distanceM),
    );
    const runningM = raceWeek.distanceM - races[0]!.target.distanceM;
    expect(runningM).toBeGreaterThanOrEqual(0.4 * peakM - EPS);
    expect(runningM).toBeLessThanOrEqual(0.6 * peakM + EPS);
  }
}

describe("generate plan", () => {
  it("keeps every rule over generated goals, baselines and VDOT sources", () => {
    fc.assert(
      fc.property(inputArb, (of) => assertPlanKeepsEveryRule(of, generatePlan(of))),
      { numRuns: 400 },
    );
  });

  it("is deterministic: the same input gives byte-identical output, a cloned input too", () => {
    fc.assert(
      fc.property(inputArb, (of) => {
        const once = JSON.stringify(generatePlan(of));
        expect(JSON.stringify(generatePlan(of))).toBe(once);
        expect(JSON.stringify(generatePlan(structuredClone(of)))).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it("does not change its input", () => {
    fc.assert(
      fc.property(inputArb, (of) => {
        const before = structuredClone(of);
        generatePlan(of);
        expect(of).toEqual(before);
      }),
      { numRuns: 50 },
    );
  });

  it("reports long_run_cap for a marathon on 3 days", () => {
    expect(
      generatePlan(
        input({
          goal: { distanceKey: "marathon", daysPerWeek: 3, raceDate: addDays(START, 7 * 20 - 1) },
        }),
      ),
    ).toEqual({
      ok: false,
      conflict: {
        code: "long_run_cap",
        distanceKey: "marathon",
        daysPerWeek: 3,
        minDaysPerWeek: 4,
      },
    });
  });

  it("makes a plan for a half on 3 days", () => {
    const half = plan(
      input({
        goal: { distanceKey: "half", daysPerWeek: 3, raceDate: addDays(START, 7 * 14 - 1) },
      }),
    );
    expect(half.weeks).toHaveLength(14);
    expect(half.weeks.every((week) => week.sessions.length <= 3)).toBe(true);
  });

  it("reports too_many_days for 6 days a week from a 10 km baseline", () => {
    const result = generatePlan(
      input({
        goal: { distanceKey: "5k", daysPerWeek: 6 },
        baseline: { weeklyVolumesM: [10_000, 10_000, 10_000, 10_000], longestRunM: 5000 },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "too_many_days", daysPerWeek: 6, baselineWeeklyM: 15_000 },
    });
    if (!result.ok && result.conflict.code === "too_many_days") {
      expect(result.conflict.maxDaysPerWeek).toBeLessThan(6);
      expect(result.conflict.maxDaysPerWeek).toBeGreaterThanOrEqual(3);
    }
  });

  it("makes a 10K race 4 weeks away a 4-week plan ending on the race, with race_date_close", () => {
    const raceDate = addDays(START, 27);
    const close = plan(input({ goal: { raceDate } }));
    expect(close.warnings).toContainEqual({ code: "race_date_close", weeks: 4, minimumWeeks: 8 });
    expect(close.weeks).toHaveLength(4);
    expect(close.endDate).toBe(raceDate);
    expect(close.weeks.at(-1)!.sessions.at(-1)).toMatchObject({ date: raceDate, type: "race" });
  });

  it("reports race_too_soon for a race the day before the start", () => {
    expect(generatePlan(input({ goal: { raceDate: addDays(START, -1) } }))).toEqual({
      ok: false,
      conflict: { code: "race_too_soon", raceDate: addDays(START, -1), earliestStart: START },
    });
  });

  it("reports no_recent_time without a VDOT source, before any other conflict", () => {
    expect(
      generatePlan(input({ vdotSource: null, goal: { raceDate: addDays(START, -1) } })),
    ).toEqual({
      ok: false,
      conflict: { code: "no_recent_time" },
    });
  });

  it("gives a 27:30 5K VDOT 34.2 and an easy band of 6:46 to 7:36/km", () => {
    const fromFiveK = plan(
      input({
        vdotSource: {
          origin: "entered",
          distanceM: 5000,
          timeS: 1650,
          activityId: null,
          date: null,
        },
      }),
    );
    expect(fromFiveK.vdot).toBe(34.2);
    expect(fromFiveK.paces.easy).toEqual({ fastSPerKm: 406, slowSPerKm: 456 });
  });

  it("warns target_time_ambitious and keeps the predicted race pace for a target far ahead", () => {
    const ambitious = plan(input({ goal: { targetTimeS: 1800 } }));
    expect(ambitious.warnings).toContainEqual(
      expect.objectContaining({ code: "target_time_ambitious", targetTimeS: 1800 }),
    );
    // 25:00 5K predicts 52:07 for 10K: 313 s/km.
    expect(ambitious.paces.race).toEqual({ fastSPerKm: 308, slowSPerKm: 317 });
  });

  it("warns no_recent_runs and starts from the floor with an empty baseline", () => {
    const fresh = plan(
      input({ baseline: { weeklyVolumesM: [0, 0, 0, 0], longestRunM: 0, daysSinceLastRun: null } }),
    );
    expect(fresh.warnings).toContainEqual({ code: "no_recent_runs", startVolumeM: 20_000 });
    expect(fresh.weeks[0]!.distanceM).toBeLessThanOrEqual(20_000);
  });

  it("warns long_run_short when the caps keep a marathon's long run under 120 min", () => {
    // A 20:00 5K runs easy at 320 s/km, so 120 min is 22.5 km; 30% of the 72 km peak is 21.6 km.
    const marathon = plan(
      input({
        goal: { distanceKey: "marathon", raceDate: addDays(START, 7 * 18 - 1) },
        baseline: { weeklyVolumesM: [30_000, 30_000, 30_000, 30_000], longestRunM: 10_000 },
        vdotSource: {
          origin: "entered",
          distanceM: 5000,
          timeS: 1200,
          activityId: null,
          date: null,
        },
      }),
    );
    expect(marathon.warnings).toContainEqual({
      code: "long_run_short",
      peakLongRunM: 21_600,
      requiredLongRunM: 22_500,
    });
  });

  it("does not warn long_run_short for a half whose 16.8 km peak long run passes 90 min", () => {
    // A 22:30 5K runs easy at 357 s/km: 90 min is 15.1 km, where 105 min would be 17.6 km.
    const half = plan(
      input({
        goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1) },
        baseline: { weeklyVolumesM: [25_000, 28_000, 22_000, 30_000], longestRunM: 15_000 },
        vdotSource: {
          origin: "entered",
          distanceM: 5000,
          timeS: 1350,
          activityId: null,
          date: null,
        },
      }),
    );
    expect(half.warnings.map((warning) => warning.code)).not.toContain("long_run_short");
  });

  it("never cuts an established long run: a 15 km longest on 26 km weeks runs 15 km in week 1 of a half", () => {
    const half = plan(
      input({
        goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1), daysPerWeek: 4 },
        baseline: { weeklyVolumesM: [25_000, 28_000, 22_000, 30_000], longestRunM: 15_000 },
      }),
    );
    const weekOneLong = half.weeks[0]!.sessions.find((session) => session.type === "long");
    expect(weekOneLong?.target.distanceM).toBe(15_000);
  });

  it("gives up only the meters a 3-day week cannot hold from a 6136 m longest beside a 5.8 km tempo", () => {
    // Base week 1 of 15 km: 6136 m and a 5798 m tempo leave 3066 m, 2 m under the 3068 m (half the long
    // run) the last easy run needs. 6135 m holds the whole week: the long run gives up 1 m, not 2.7 km
    // of the week or the 742 m its share of the shorter week would.
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
    const result = generatePlan(fitness);
    assertPlanKeepsEveryRule(fitness, result);
    const weekOne = plan(fitness).weeks[0]!;
    expect(weekOne.distanceM).toBe(15_000);
    expect(weekOne.sessions.map((session) => [session.type, session.target.distanceM])).toEqual([
      ["long", 6135],
      ["tempo", 5798],
      ["easy", 3067],
    ]);
  });

  it("cuts a half's race week to 40% of the peak-phase week, the race excluded, short easy runs before it", () => {
    const half = plan(
      input({
        goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1), daysPerWeek: 4 },
        baseline: { weeklyVolumesM: [25_000, 28_000, 22_000, 30_000], longestRunM: 15_000 },
      }),
    );
    const peakM = Math.max(
      ...half.weeks.filter((week) => week.phase === "peak").map((week) => week.distanceM),
    );
    const raceWeek = half.weeks.at(-1)!;
    const running = raceWeek.sessions.filter((session) => session.type !== "race");
    expect(running.reduce((sum, session) => sum + session.target.distanceM, 0)).toBe(
      Math.ceil(0.4 * peakM),
    );
    for (const session of running) {
      expect(session.target.distanceM).toBeLessThan(0.2 * peakM);
    }
  });

  it("gives a 3-day runner tempo sessions in base and build weeks", () => {
    const half = plan(
      input({
        goal: { distanceKey: "half", daysPerWeek: 3, raceDate: addDays(START, 7 * 14 - 1) },
      }),
    );
    for (const phase of ["base", "build"] as const) {
      const types = half.weeks
        .filter((week) => week.phase === phase)
        .flatMap((week) => week.sessions.map((session) => session.type));
      expect(types).toContain("tempo");
      expect(types).toContain("intervals");
    }
  });

  it("makes a fitness goal a 12-week plan with no race, shaped like a 10K without a distance", () => {
    const fitness = plan(input({ goal: { kind: "fitness", distanceKey: null, raceDate: null } }));
    expect(fitness.weeks).toHaveLength(12);
    expect(fitness.endDate).toBe(addDays(START, 83));
    expect(
      fitness.weeks.flatMap((week) => week.sessions).some((session) => session.type === "race"),
    ).toBe(false);
    expect(fitness.weeks.map((week) => week.phase)).toEqual(
      (["base", "build", "peak"] as const).flatMap((phase) => [phase, phase, phase, phase]),
    );
  });

  it("stamps the engine version and runs the race at its distance in whole meters", () => {
    const half = plan(
      input({ goal: { distanceKey: "half", raceDate: addDays(START, 7 * 12 - 1) } }),
    );
    expect(half.engineVersion).toBe("0.2.0");
    expect(half.weeks.at(-1)!.sessions.at(-1)!.steps).toEqual([
      { kind: "run", zone: "race", distanceM: 21_098, durationS: null },
    ]);
  });

  it("rests the Sunday before a Monday race and keeps 48 h before it", () => {
    const monday = plan(input({ goal: { raceDate: addDays(START, 7 * 10), longRunDay: "sun" } }));
    const sessions = monday.weeks.flatMap((week) => week.sessions);
    expect(sessions.some((session) => session.date === addDays(START, 7 * 10 - 1))).toBe(false);
    assertPlanKeepsEveryRule(
      input({ goal: { raceDate: addDays(START, 7 * 10), longRunDay: "sun" } }),
      { ok: true, plan: monday },
    );
  });

  it("throws on an input the contract rejects, a start that is not a Monday", () => {
    expect(() => generatePlan(input({ startDate: "2026-10-06" }))).toThrow();
  });
});
