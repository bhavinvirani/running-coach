import {
  planGenerationResultSchema,
  weekdaySchema,
  type GeneratedPlan,
  type GeneratedSession,
  type GeneratedWeek,
  type PlanGenerationInput,
  type PlanPaces,
  type RaceDistanceKey,
  type SessionSteps,
  type Step,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, weekdayOf } from "../dates";
import { reEnteredVolumeM } from "../rules/baseline";
import { bandMidpointSPerKm } from "../rules/session-target";
import { fillWeek, minRunDistanceM } from "../rules/week-fill";
import { generatePlan, planStartVolume } from "./generate";
import {
  distanceKeyArb,
  mondayArb,
  planInputArb as inputArb,
  sourceArb,
  sourceOf,
} from "./plan-arbitraries";

const START = "2026-10-05"; // a Monday
const QUALITY_TYPES = new Set(["intervals", "tempo", "race_practice"]);
const HARD_TYPES = new Set(["long", "intervals", "tempo", "race_practice", "race"]);
const HARD_ZONES = new Set(["threshold", "interval", "repetition", "race"]);
const WORK_CAP = { threshold: 0.1, interval: 0.08, repetition: 0.05, race: 0.1 } as const;
const MIN_WEEKS = { "5k": 8, "10k": 8, half: 12, marathon: 18 } as const;
const MIN_DAYS = { "5k": 3, "10k": 3, half: 3, marathon: 4 } as const;
const EPS = 1e-9;

/** 30% of the week from 4 runs, 40% at 3, 1.2/n of fewer (a taper block cut short). */
const shareFor = (runs: number) => (runs >= 4 ? 0.3 : runs === 3 ? 0.4 : 1.2 / runs);
const sumM = (sessions: readonly GeneratedSession[]) =>
  sessions.reduce((sum, session) => sum + session.target.distanceM, 0);
const between = (date: string, first: string, last: string) =>
  daysBetween(first, date) >= 0 && daysBetween(date, last) >= 0;

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
 * Whether a week of `weekM` holds the baseline's longest run as its long run: this week's quality
 * sessions unpadded and 20 min on every easy day, and every meter placed beside it by fillWeek's rules.
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
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const easySlots = daysPerWeek - 1 - qualityM.length;
  if (weekM - sum(qualityM) - easySlots * minRunM < longM) return false;
  const restM = weekM - longM;
  const fill = fillWeek({ restM, capM: longM, qualityM, easySlots, minRunM });
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

// --- the taper as the SPEC sets it -----------------------------------------------------------------

interface Block {
  number: number;
  first: string;
  last: string;
  fraction: number;
}

/** 7-day blocks counted back from race day, oldest first, cut at the plan's first day. */
function taperOf(of: PlanGenerationInput): { start: string; blocks: Block[] } | null {
  const { raceDate, distanceKey } = of.goal;
  if (raceDate === null) return null;
  const fractions = distanceKey === "marathon" ? [0.8, 0.6, 0.4] : [0.65, 0.4];
  const blocks: Block[] = [];
  fractions.forEach((fraction, k) => {
    const number = fractions.length - k;
    const first = addDays(raceDate, -7 * number);
    const last = addDays(first, 6);
    if (daysBetween(of.startDate, last) < 0) return;
    blocks.push({
      number,
      first: daysBetween(of.startDate, first) < 0 ? of.startDate : first,
      last,
      fraction,
    });
  });
  return { start: addDays(raceDate, -7 * fractions.length), blocks };
}

/** The running in the 7-day blocks, oldest first, and the whole weeks before the taper. */
function taperNumbers(of: PlanGenerationInput, weeks: readonly GeneratedWeek[]) {
  const taper = taperOf(of)!;
  const sessions = weeks.flatMap((week) => week.sessions).filter((s) => s.type !== "race");
  const wholeWeeks = weeks.filter(
    (week) => daysBetween(addDays(week.startDate, 6), taper.start) > 0,
  );
  return {
    taper,
    blocksM: taper.blocks.map((block) =>
      sumM(sessions.filter((s) => between(s.date, block.first, block.last))),
    ),
    wholeWeeks,
    peakM: Math.max(...wholeWeeks.map((week) => week.distanceM)),
  };
}

// --- arbitraries ----------------------------------------------------------------------------------

/** Race plans at least the distance's minimum, on every race weekday, from a runner with history. */
const fullRaceArb: fc.Arbitrary<PlanGenerationInput> = fc
  .record({
    startDate: mondayArb,
    distanceKey: distanceKeyArb,
    extraWeeks: fc.integer({ min: 0, max: 10 }),
    raceWeekday: fc.integer({ min: 0, max: 6 }),
    daysPerWeek: fc.integer({ min: 3, max: 6 }),
    longRunDay: fc.constantFrom(...weekdaySchema.options),
    weeklyVolumesM: fc.array(fc.integer({ min: 15_000, max: 90_000 }), {
      minLength: 4,
      maxLength: 4,
    }),
    longestRunM: fc.integer({ min: 0, max: 30_000 }),
    daysSinceLastRun: fc.integer({ min: 0, max: 20 }),
    source: sourceArb,
  })
  .map((drawn) => {
    const weeks = MIN_WEEKS[drawn.distanceKey] + drawn.extraWeeks;
    return {
      goal: {
        kind: "race" as const,
        distanceKey: drawn.distanceKey,
        raceDate: addDays(drawn.startDate, 7 * (weeks - 1) + drawn.raceWeekday),
        targetTimeS: null,
        daysPerWeek: Math.max(drawn.daysPerWeek, MIN_DAYS[drawn.distanceKey]),
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
    };
  });

// --- the whole-plan property ----------------------------------------------------------------------

/**
 * The shares one sizing unit keeps (a whole week, the days of a week before its taper, or a taper
 * block): each session's work within T 10%, I 8%, R 5% and race pace 10% of `weekM`, the long run
 * within `share` of it (never cut below `floorM` before the taper) and 150 min, no quality session
 * past the long run, and 80% of the time of `easyOver` easy, when given.
 */
function assertShares(
  label: string,
  paces: PlanPaces,
  {
    sessions,
    weekM,
    share,
    floorM,
    longM,
    easyOver,
  }: {
    sessions: readonly GeneratedSession[];
    weekM: number;
    share: number;
    floorM: number;
    /** The long run the unit's sessions stay under, null with none. */
    longM: number | null;
    easyOver: readonly GeneratedSession[] | null;
  },
): void {
  for (const long of sessions.filter((session) => session.type === "long")) {
    expect(long.target.distanceM, label).toBeLessThanOrEqual(Math.max(share * weekM, floorM) + EPS);
    expect(long.target.durationS, label).toBeLessThanOrEqual(9000);
  }
  for (const session of sessions.filter((s) => QUALITY_TYPES.has(s.type))) {
    if (longM !== null) expect(session.target.distanceM, label).toBeLessThanOrEqual(longM);
    const work = counted(session.steps).filter(({ step }) => step.kind === "work");
    expect(work.length, label).toBeGreaterThan(0);
    for (const zone of new Set(work.map(({ step }) => step.zone))) {
      const workM = work
        .filter(({ step }) => step.zone === zone)
        .reduce((sum, { step, times }) => sum + times * stepMeters(step, paces), 0);
      expect(workM, label).toBeLessThanOrEqual(
        WORK_CAP[zone as keyof typeof WORK_CAP] * weekM + EPS,
      );
    }
  }
  if (easyOver === null) return;
  const totalS = easyOver.reduce((sum, session) => sum + session.target.durationS, 0);
  const hardS = easyOver
    .flatMap((session) => counted(session.steps))
    .filter(({ step }) => step.kind === "work" && HARD_ZONES.has(step.zone))
    .reduce((sum, { step, times }) => sum + times * stepSeconds(step, paces), 0);
  expect(hardS, label).toBeLessThanOrEqual(0.2 * totalS + EPS);
}

function assertPlanKeepsEveryRule(
  of: PlanGenerationInput,
  result: ReturnType<typeof generatePlan>,
): void {
  expect(planGenerationResultSchema.parse(result)).toEqual(result);
  const { goal, baseline } = of;
  const distanceKey: RaceDistanceKey = goal.distanceKey ?? "10k";
  if (!result.ok) {
    if (result.conflict.code === "too_many_days") {
      // Fewer days fit the 10% rule, and the plan for that many starts within it.
      const { daysPerWeek, maxDaysPerWeek, recentWeeklyM, neededWeeklyM } = result.conflict;
      expect(daysPerWeek).toBe(goal.daysPerWeek);
      expect(maxDaysPerWeek).toBeLessThan(goal.daysPerWeek);
      expect(maxDaysPerWeek).toBeGreaterThanOrEqual(MIN_DAYS[distanceKey]);
      expect(recentWeeklyM).toBe(reEnteredVolumeM(baseline));
      expect(neededWeeklyM).toBeGreaterThan(Math.floor(recentWeeklyM * 1.1));
      const fewer = planStartVolume({ ...of, goal: { ...goal, daysPerWeek: maxDaysPerWeek } });
      expect(fewer).toMatchObject({ ok: true, warning: null });
      if (fewer.ok) {
        expect(fewer.startVolumeM).toBeLessThanOrEqual(
          Math.max(recentWeeklyM, Math.floor(recentWeeklyM * 1.1)),
        );
      }
    }
    return;
  }
  const { paces, weeks } = result.plan;
  const minRunM = Math.ceil((1200 * 1000) / midpoint(paces, "easy"));
  const longRunMaxM = Math.floor((9000 * 1000) / midpoint(paces, "easy"));
  const taper = taperOf(of);
  const isTaper = (date: string) => taper !== null && daysBetween(taper.start, date) >= 0;
  const blockOneStart = goal.raceDate === null ? null : addDays(goal.raceDate, -7);

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

  // Week 1 runs the start volume the rule sets, unless 110% of the recent longest run caps every run
  // of it: then every session is at the long run and the week holds what that allows.
  const start = planStartVolume(of);
  if (!start.ok) throw new Error("a plan has a start volume");
  if (start.warning !== null) expect(result.plan.warnings).toContainEqual(start.warning);
  const weekOne = weeks[0]!;
  if (!weeks[0]!.sessions.some((s) => isTaper(s.date)) && weekOne.phase !== "race") {
    const longM = weekOne.sessions.find((s) => s.type === "long")?.target.distanceM;
    if (weekOne.distanceM !== start.startVolumeM) {
      expect(weekOne.distanceM, "week 1").toBeLessThan(start.startVolumeM);
      expect(weekOne.sessions.map((s) => s.target.distanceM)).toEqual(
        weekOne.sessions.map(() => longM),
      );
    }
  }

  const seedM = Math.max(baseline.longestRunM, 5000);
  const longestByWeek: number[] = [];
  let previousNonDownM: number | null = null;

  weeks.forEach((week, k) => {
    const label = `week ${week.number}`;
    expect(week.number).toBe(k + 1);
    expect(week.startDate).toBe(addDays(of.startDate, 7 * k));
    expect(weekdayOf(week.startDate)).toBe("mon");
    expect(week.distanceM).toBe(sumM(week.sessions));
    expect(week.sessions.length, label).toBeLessThanOrEqual(goal.daysPerWeek);

    const dates = week.sessions.map((session) => session.date);
    dates
      .slice(1)
      .forEach((date, j) => expect(daysBetween(dates[j]!, date)).toBeGreaterThanOrEqual(1));
    for (const date of dates) {
      expect(between(date, week.startDate, addDays(week.startDate, 6))).toBe(true);
      expect(between(date, result.plan.startDate, result.plan.endDate)).toBe(true);
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

    // At most 2 quality sessions, 1 at 3 days.
    expect(week.sessions.filter((s) => QUALITY_TYPES.has(s.type)).length).toBeLessThanOrEqual(
      goal.daysPerWeek === 3 ? 1 : 2,
    );

    // No run over 110% of the longest of the last 4 weeks, the baseline standing in before the plan.
    const window = longestByWeek.slice(-4);
    const longestRecent = Math.max(...window, window.length < 4 ? seedM : 0);
    const runs = week.sessions.filter((session) => session.type !== "race");
    for (const run of runs) {
      expect(run.target.distanceM, label).toBeLessThanOrEqual(Math.floor(longestRecent * 1.1));
    }
    longestByWeek.push(Math.max(0, ...runs.map((run) => run.target.distanceM)));

    // The long run on its day, except in the 7 days before the race and the race week.
    const longDate = addDays(week.startDate, weekdaySchema.options.indexOf(goal.longRunDay));
    const longs = week.sessions.filter((session) => session.type === "long");
    const noLong =
      week.phase === "race" ||
      (blockOneStart !== null && daysBetween(blockOneStart, longDate) >= 0);
    expect(
      longs.map((session) => session.date),
      label,
    ).toEqual(noLong ? [] : [longDate]);

    // Every day asked for runs, but in the race week and where a taper block rests one: a block rests a
    // day it lays out only when its easy runs cannot take one more 20 min run (fillWeek), as when the
    // taper's share of the peak is short of 20 min on each of its days.
    if (week.phase !== "race" && week.sessions.length < goal.daysPerWeek) {
      const weekEnd = addDays(week.startDate, 6);
      const resting = (taper?.blocks ?? []).filter((block) => {
        const easy = sessions.filter(
          (s) => s.type === "easy" && between(s.date, block.first, block.last),
        );
        return (
          daysBetween(block.first, weekEnd) >= 0 &&
          daysBetween(week.startDate, block.last) >= 0 &&
          sumM(easy) < (easy.length + 1) * minRunM
        );
      });
      expect(resting, `${label} runs ${week.sessions.length} days`).not.toEqual([]);
    }

    const isPreTaper = week.phase === "base" || week.phase === "build" || week.phase === "peak";
    if (!isPreTaper) return;
    // Every 4th week recovers to 80% of the week before as built; the others climb at most 10% over
    // the last week that was not a down week.
    const previous = weeks[k - 1];
    if (week.number % 4 === 0) {
      expect(week.distanceM, label).toBeLessThanOrEqual(Math.floor(0.8 * previous!.distanceM));
    } else {
      if (previousNonDownM !== null) {
        expect(week.distanceM, label).toBeLessThanOrEqual(Math.floor(previousNonDownM * 1.1));
      }
      previousNonDownM = week.distanceM;
    }

    const own = week.sessions.filter((session) => !isTaper(session.date));
    const longM = longs[0]?.target.distanceM ?? null;
    // By its days, not its sessions: a block can rest every taper day of the week the taper starts in.
    if (!isTaper(addDays(week.startDate, 6))) {
      // A whole week before the taper runs every day asked for and keeps its shares.
      expect(week.sessions.length, label).toBe(goal.daysPerWeek);
      assertShares(label, paces, {
        sessions: week.sessions,
        weekM: week.distanceM,
        share: shareFor(goal.daysPerWeek),
        floorM: baseline.longestRunM,
        longM,
        easyOver: week.sessions,
      });
      // The share never cuts the baseline's longest run in a week that can hold it (150 min and 110%
      // of the recent longest allowing).
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
      if (longM !== null && canHoldBaselineLongest) {
        expect(longM, label).toBeGreaterThanOrEqual(baseline.longestRunM);
      }
    } else {
      // The week the taper starts in: its own days keep the week's shares beside the taper's, and
      // their quality sessions never take the week past 20% hard (the taper's days keep their block's).
      assertShares(`${label} before the taper`, paces, {
        sessions: own,
        weekM: week.distanceM,
        share: shareFor(week.sessions.length),
        floorM: baseline.longestRunM,
        longM,
        easyOver: own.some((session) => QUALITY_TYPES.has(session.type)) ? week.sessions : null,
      });
    }
  });

  // 48 h between hard days, across week boundaries too.
  const hardDates = sessions
    .filter((session) => HARD_TYPES.has(session.type))
    .map((session) => session.date);
  hardDates
    .slice(1)
    .forEach((date, k) => expect(daysBetween(hardDates[k]!, date)).toBeGreaterThanOrEqual(2));

  if (taper === null) return;
  const { blocksM, wholeWeeks, peakM } = taperNumbers(of, weeks);
  taper.blocks.forEach((block, k) => {
    const label = `taper block ${block.number}`;
    const own = sessions.filter(
      (s) => s.type !== "race" && between(s.date, block.first, block.last),
    );
    const longs = own.filter((s) => s.type === "long");
    expect(longs.length, label).toBeLessThanOrEqual(1);
    assertShares(label, paces, {
      sessions: own,
      weekM: blocksM[k]!,
      share: shareFor(own.length),
      floorM: 0,
      longM: longs[0]?.target.distanceM ?? null,
      easyOver: own,
    });
    // Never rising: each block under the one before when that one ran all 7 days, the first under the
    // last whole week.
    const before = taper.blocks[k - 1];
    if (before !== undefined) {
      if (daysBetween(before.first, before.last) === 6) {
        expect(blocksM[k]!, label).toBeLessThanOrEqual(blocksM[k - 1]!);
      }
    } else if (wholeWeeks.length > 0) {
      expect(blocksM[k]!, label).toBeLessThanOrEqual(wholeWeeks.at(-1)!.distanceM);
    }
    if (wholeWeeks.length > 0) {
      expect(blocksM[k]!, label).toBeLessThanOrEqual(Math.ceil(block.fraction * peakM));
    }
  });

  // The 7 days before the race: no long run, nothing the day before, one race practice at most, at
  // least 3 days out.
  const lastSeven = sessions.filter(
    (s) => s.type !== "race" && between(s.date, blockOneStart!, addDays(goal.raceDate!, -1)),
  );
  expect(lastSeven.filter((s) => s.type === "long")).toEqual([]);
  expect(lastSeven.map((s) => s.date)).not.toContain(addDays(goal.raceDate!, -1));
  const practice = lastSeven.filter((s) => QUALITY_TYPES.has(s.type));
  expect(practice.length).toBeLessThanOrEqual(1);
  for (const session of practice) {
    expect(session.type).toBe("race_practice");
    expect(daysBetween(session.date, goal.raceDate!)).toBeGreaterThanOrEqual(3);
  }

  // A full taper cuts the 7 days before the race to 40-60% of the peak, whatever the race's weekday.
  if (weeks.length >= MIN_WEEKS[distanceKey]) {
    const lastBlockM = blocksM.at(-1)!;
    expect(lastBlockM, "the 7 days before the race").toBeGreaterThanOrEqual(0.4 * peakM - EPS);
    expect(lastBlockM, "the 7 days before the race").toBeLessThanOrEqual(0.6 * peakM + EPS);
  }
}

// Each property builds hundreds of plans of up to 52 weeks; CI's runner needs more than vitest's 5 s.
const PROPERTY_TIMEOUT_MS = 120_000;

describe("generate plan", () => {
  it("keeps every rule over generated goals, baselines and VDOT sources", () => {
    fc.assert(
      fc.property(inputArb, (of) => assertPlanKeepsEveryRule(of, generatePlan(of))),
      { numRuns: 400 },
    );
    // Each plan searches the week its days need through the week builder: a few seconds in all.
  }, 30_000);

  it("tapers the 7 days before a race on any weekday to 40-60% of the peak, the 7 before them to the next share", () => {
    fc.assert(
      fc.property(fullRaceArb, (of) => {
        const result = generatePlan(of);
        assertPlanKeepsEveryRule(of, result);
        fc.pre(result.ok);
        if (!result.ok) return;
        const { taper, blocksM, peakM } = taperNumbers(of, result.plan.weeks);
        expect(taper.blocks.map((block) => block.number)).toEqual(
          of.goal.distanceKey === "marathon" ? [3, 2, 1] : [2, 1],
        );
        expect(blocksM.at(-2)!).toBeGreaterThanOrEqual(blocksM.at(-1)!);
        expect(blocksM.at(-2)!).toBeLessThanOrEqual(
          Math.ceil((of.goal.distanceKey === "marathon" ? 0.6 : 0.65) * peakM),
        );
      }),
      { numRuns: 200 },
    );
    // Each plan searches the week its days need through the week builder: a few seconds in all.
  }, 30_000);

  it(
    "is deterministic: the same input gives byte-identical output, a cloned input too",
    () => {
      fc.assert(
        fc.property(inputArb, (of) => {
          const once = JSON.stringify(generatePlan(of));
          expect(JSON.stringify(generatePlan(of))).toBe(once);
          expect(JSON.stringify(generatePlan(structuredClone(of)))).toBe(once);
        }),
        { numRuns: 100 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "does not change its input",
    () => {
      fc.assert(
        fc.property(inputArb, (of) => {
          const before = structuredClone(of);
          generatePlan(of);
          expect(of).toEqual(before);
        }),
        { numRuns: 50 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "reports long_run_cap for a marathon on 3 days",
    () => {
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
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "makes a plan for a half on 3 days",
    () => {
      const half = plan(
        input({
          goal: { distanceKey: "half", daysPerWeek: 3, raceDate: addDays(START, 7 * 14 - 1) },
        }),
      );
      expect(half.weeks).toHaveLength(14);
      expect(half.weeks.every((week) => week.sessions.length <= 3)).toBe(true);
    },
    PROPERTY_TIMEOUT_MS,
  );

  it("sizes every 4th week from the week before as built: a half from an 8 km longest runs weeks 1 to 5 at 35 200, 38 720, 42 592, 34 073 and 46 848 m", () => {
    // The 110% run cap holds weeks 1 to 3 under the curve; week 4 recovers to 80% of week 3 as run.
    const capped = input({
      goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1) },
      baseline: { weeklyVolumesM: [40_000, 40_000, 40_000, 40_000], longestRunM: 8000 },
    });
    assertPlanKeepsEveryRule(capped, generatePlan(capped));
    expect(
      plan(capped)
        .weeks.slice(0, 5)
        .map((week) => week.distanceM),
    ).toEqual([35_200, 38_720, 42_592, 34_073, 46_848]);
  });

  it("starts a half on 4 days after 20 days off at re-entry: 20 km from 40 km weeks, not a floor", () => {
    const back = input({
      goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1) },
      baseline: {
        weeklyVolumesM: [40_000, 40_000, 40_000, 40_000],
        longestRunM: 8000,
        daysSinceLastRun: 20,
      },
    });
    assertPlanKeepsEveryRule(back, generatePlan(back));
    expect(plan(back).weeks[0]!.distanceM).toBe(20_000);
    expect(plan(back).warnings).toEqual([]);
  });

  it("restarts at 30 km, not 60, after three empty weeks and a run yesterday", () => {
    const back = input({
      goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1) },
      baseline: { weeklyVolumesM: [60_000, 0, 0, 0], longestRunM: 8000, daysSinceLastRun: 1 },
    });
    assertPlanKeepsEveryRule(back, generatePlan(back));
    expect(plan(back).weeks[0]!.distanceM).toBe(30_000);
  });

  it("lifts week 1 with start_volume_lifted for 6 days a week from a 10 km baseline, which not even 3 days fit", () => {
    const sixDays = input({
      goal: { distanceKey: "5k", daysPerWeek: 6 },
      baseline: { weeklyVolumesM: [10_000, 10_000, 10_000, 10_000], longestRunM: 5000 },
    });
    const result = generatePlan(sixDays);
    assertPlanKeepsEveryRule(sixDays, result);
    const weekOne = plan(sixDays).weeks[0]!;
    expect(weekOne.sessions).toHaveLength(6);
    expect(weekOne.distanceM).toBeGreaterThan(11_000);
    expect(plan(sixDays).warnings).toContainEqual({
      code: "start_volume_lifted",
      recentWeeklyM: 10_000,
      startVolumeM: weekOne.distanceM,
    });
  });

  it("lifts week 1 to the week 6 days need at 10% over recent volume, and reports too_many_days 1 m under it", () => {
    const sixDays = (weekM: number) =>
      input({
        goal: { distanceKey: "5k", daysPerWeek: 6 },
        baseline: { weeklyVolumesM: [weekM, weekM, weekM, weekM], longestRunM: 9000 },
      });
    // With no history the plan starts at the week 6 days need, here above the 5K floor.
    const fresh = planStartVolume({
      ...sixDays(0),
      baseline: { weeklyVolumesM: [0, 0, 0, 0], longestRunM: 9000, daysSinceLastRun: null },
    });
    if (!fresh.ok) throw new Error("no history has a start volume");
    const neededM = fresh.startVolumeM;
    expect(neededM).toBeGreaterThan(15_000);
    let recentM = Math.ceil(neededM / 1.1) - 2;
    while (Math.floor(recentM * 1.1) < neededM) recentM += 1;
    const atTen = generatePlan(sixDays(recentM));
    assertPlanKeepsEveryRule(sixDays(recentM), atTen);
    expect(atTen.ok && atTen.plan.weeks[0]!.distanceM).toBe(neededM);
    expect(atTen.ok && atTen.plan.warnings).toEqual([]);
    const under = generatePlan(sixDays(recentM - 1));
    assertPlanKeepsEveryRule(sixDays(recentM - 1), under);
    expect(under).toEqual({
      ok: false,
      conflict: {
        code: "too_many_days",
        daysPerWeek: 6,
        maxDaysPerWeek: 5,
        recentWeeklyM: recentM - 1,
        neededWeeklyM: neededM,
      },
    });
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

  it("makes a race on the 52nd Sunday a plan and reports race_too_far for the 53rd Monday", () => {
    expect(plan(input({ goal: { raceDate: addDays(START, 363) } })).weeks).toHaveLength(52);
    expect(generatePlan(input({ goal: { raceDate: addDays(START, 364) } }))).toEqual({
      ok: false,
      conflict: {
        code: "race_too_far",
        raceDate: addDays(START, 364),
        latestRaceDate: addDays(START, 363),
      },
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

  it("warns no_recent_runs and starts at the week the days need, never under the floor, with an empty baseline", () => {
    const fresh = input({
      baseline: { weeklyVolumesM: [0, 0, 0, 0], longestRunM: 0, daysSinceLastRun: null },
    });
    const result = generatePlan(fresh);
    assertPlanKeepsEveryRule(fresh, result);
    const { warnings, weeks } = plan(fresh);
    const noRuns = warnings.find((warning) => warning.code === "no_recent_runs");
    expect(noRuns).toMatchObject({ code: "no_recent_runs" });
    expect(noRuns!.code === "no_recent_runs" && noRuns!.startVolumeM).toBeGreaterThanOrEqual(
      20_000,
    );
    expect(weeks[0]!.distanceM).toBeLessThanOrEqual(
      noRuns!.code === "no_recent_runs" ? noRuns!.startVolumeM : 0,
    );
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

  it("never cuts an established long run the week can hold: a 15 km longest on 30 km weeks runs 15 km in week 1 of a half", () => {
    const half = plan(
      input({
        goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1), daysPerWeek: 4 },
        baseline: { weeklyVolumesM: [30_000, 30_000, 30_000, 30_000], longestRunM: 15_000 },
      }),
    );
    const weekOne = half.weeks[0]!;
    expect(weekOne.sessions).toHaveLength(4);
    expect(weekOne.sessions.find((session) => session.type === "long")?.target.distanceM).toBe(
      15_000,
    );
  });

  it("gives way on the long run before an easy day: the seeded half on 4 days runs 4 sessions in week 1", () => {
    // The e2e seed: 22 to 30 km weeks, a 15 km longest and a typed-in 10K of 54:41. Week 1 of 26 250 m
    // cannot hold 15 km, the tempo and two 20 min runs, so the long run takes what they leave.
    const seeded = input({
      goal: {
        distanceKey: "half",
        raceDate: addDays(START, 7 * 20 - 1),
        daysPerWeek: 4,
        longRunDay: "sun",
        recentTime: { distanceKey: "10k", timeS: 3281 },
      },
      baseline: {
        weeklyVolumesM: [25_000, 28_000, 22_000, 30_000],
        longestRunM: 15_000,
        daysSinceLastRun: 2,
      },
      vdotSource: {
        origin: "entered",
        distanceM: 10_000,
        timeS: 3281,
        activityId: null,
        date: null,
      },
    });
    const result = generatePlan(seeded);
    assertPlanKeepsEveryRule(seeded, result);
    const { paces, weeks } = plan(seeded);
    const weekOne = weeks[0]!;
    const minRunM = minRunDistanceM(bandMidpointSPerKm(paces.easy));
    expect(weekOne.distanceM).toBe(26_250);
    expect(weekOne.sessions.map((session) => session.type)).toEqual([
      "easy",
      "tempo",
      "easy",
      "long",
    ]);
    const byType = (type: string) =>
      weekOne.sessions.filter((s) => s.type === type).map((s) => s.target.distanceM);
    expect(byType("easy")).toEqual([minRunM, minRunM]);
    expect(byType("long")).toEqual([weekOne.distanceM - byType("tempo")[0]! - 2 * minRunM]);
    expect(byType("long")[0]).toBeLessThan(15_000);
  });

  it("tapers a Monday race in the two whole weeks before it: 65% then 40% of the peak, the race week only the race", () => {
    const monday = input({
      goal: { distanceKey: "half", raceDate: addDays(START, 7 * 14), daysPerWeek: 4 },
      baseline: { weeklyVolumesM: [30_000, 30_000, 30_000, 30_000], longestRunM: 15_000 },
    });
    const result = generatePlan(monday);
    assertPlanKeepsEveryRule(monday, result);
    const { weeks } = plan(monday);
    expect(weeks.map((week) => week.phase).slice(-5)).toEqual([
      "peak",
      "peak",
      "taper",
      "taper",
      "race",
    ]);
    expect(weeks.at(-1)!.sessions.map((session) => session.type)).toEqual(["race"]);
    const { blocksM, peakM } = taperNumbers(monday, weeks);
    expect(blocksM).toEqual([Math.ceil(0.65 * peakM), Math.ceil(0.4 * peakM)]);
    expect(weeks.at(-2)!.distanceM).toBe(Math.ceil(0.4 * peakM));
    const lastWeek = weeks.at(-2)!.sessions;
    expect(lastWeek.map((session) => session.date)).not.toContain(addDays(START, 7 * 14 - 1));
    expect(lastWeek.filter((session) => session.type === "long")).toEqual([]);
    expect(lastWeek.filter((session) => session.type === "race_practice")).toHaveLength(1);
  });

  it("tapers a Thursday race in the 7 days before it, Thursday to Wednesday: 40% of the peak, race practice on Monday", () => {
    const raceDate = addDays(START, 7 * 14 + 3);
    const thursday = input({
      goal: { distanceKey: "half", raceDate, daysPerWeek: 4 },
      baseline: { weeklyVolumesM: [30_000, 30_000, 30_000, 30_000], longestRunM: 15_000 },
    });
    const result = generatePlan(thursday);
    assertPlanKeepsEveryRule(thursday, result);
    const { weeks } = plan(thursday);
    expect(weeks.map((week) => week.phase).slice(-4)).toEqual(["peak", "peak", "taper", "race"]);
    const { blocksM, peakM } = taperNumbers(thursday, weeks);
    expect(blocksM).toEqual([Math.ceil(0.65 * peakM), Math.ceil(0.4 * peakM)]);
    const lastSeven = weeks
      .flatMap((week) => week.sessions)
      .filter((s) => s.type !== "race" && between(s.date, addDays(raceDate, -7), raceDate));
    expect(lastSeven.map((session) => [session.date, session.type])).toContainEqual([
      addDays(raceDate, -3),
      "race_practice",
    ]);
    expect(lastSeven.map((session) => session.date)).not.toContain(addDays(raceDate, -1));
    expect(lastSeven.filter((session) => session.type === "long")).toEqual([]);
  });

  it("cuts the 7 days before a Sunday half to 40% of the peak, the race excluded, short easy runs in them", () => {
    const sunday = input({
      goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1), daysPerWeek: 4 },
      baseline: { weeklyVolumesM: [25_000, 28_000, 22_000, 30_000], longestRunM: 15_000 },
    });
    const { weeks } = plan(sunday);
    const { blocksM, peakM } = taperNumbers(sunday, weeks);
    expect(blocksM.at(-1)).toBe(Math.ceil(0.4 * peakM));
    const lastSeven = weeks
      .flatMap((week) => week.sessions)
      .filter(
        (s) =>
          s.type !== "race" &&
          between(s.date, addDays(START, 7 * 19 - 1), addDays(START, 7 * 20 - 2)),
      );
    for (const session of lastSeven) {
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
    expect(half.engineVersion).toBe("0.4.0");
    expect(half.weeks.at(-1)!.sessions.at(-1)!.steps).toEqual([
      { kind: "run", zone: "race", distanceM: 21_098, durationS: null },
    ]);
  });

  it("rests the Sunday before a Monday 5K on 3 days and moves its long run to a free day as an easy run", () => {
    const monday = input({
      goal: {
        distanceKey: "5k",
        raceDate: addDays(START, 7 * 13),
        longRunDay: "sun",
        daysPerWeek: 3,
      },
    });
    const result = generatePlan(monday);
    assertPlanKeepsEveryRule(monday, result);
    const weekBefore = plan(monday).weeks.at(-2)!;
    expect(weekBefore.sessions.some((session) => session.type === "long")).toBe(false);
    expect(weekBefore.sessions).toHaveLength(3);
    expect(weekBefore.sessions.map((session) => session.date)).not.toContain(
      addDays(START, 7 * 13 - 1),
    );
  });

  it("keeps every rule for seed 131140314, a 5K 3 weeks out on 5 days from no runs: week 1 runs all 5, its Sunday in the taper", () => {
    const close: PlanGenerationInput = {
      goal: {
        kind: "race",
        distanceKey: "5k",
        raceDate: "2025-01-26",
        targetTimeS: null,
        daysPerWeek: 5,
        longRunDay: "wed",
        recentTime: null,
      },
      startDate: "2025-01-06",
      baseline: { weeklyVolumesM: [0, 0, 0, 0], longestRunM: 0, daysSinceLastRun: null },
      vdotSource: { origin: "entered", distanceM: 5000, timeS: 1693, activityId: null, date: null },
    };
    const result = generatePlan(close);
    assertPlanKeepsEveryRule(close, result);
    const weekOne = plan(close).weeks[0]!;
    expect(weekOne.sessions).toHaveLength(5);
    expect(weekOne.sessions.at(-1)!.date).toBe("2025-01-12");
  });

  it("rests a laid-out day of the week the taper starts in only when its block's easy runs cannot take another 20 min run", () => {
    // A half on Saturday 3 weeks out, 6 days, no recent runs: the taper starts on week 1's Saturday and
    // its first 7 days hold 65% of the 26 520 m start beside a 20 min long run, 3 easy runs short of
    // 4 x 20 min, so week 1 runs 5 days.
    const saturday: PlanGenerationInput = {
      goal: {
        kind: "race",
        distanceKey: "half",
        raceDate: "2025-12-27",
        targetTimeS: null,
        daysPerWeek: 6,
        longRunDay: "thu",
        recentTime: { distanceKey: "10k", timeS: 8930 },
      },
      startDate: "2025-12-08",
      baseline: { weeklyVolumesM: [9, 6, 74_381, 53_233], longestRunM: 15, daysSinceLastRun: null },
      vdotSource: {
        origin: "entered",
        distanceM: 10_000,
        timeS: 2085,
        activityId: null,
        date: null,
      },
    };
    const result = generatePlan(saturday);
    assertPlanKeepsEveryRule(saturday, result);
    const { paces, weeks } = plan(saturday);
    const minRunM = minRunDistanceM(bandMidpointSPerKm(paces.easy));
    expect(weeks[0]!.sessions).toHaveLength(5);
    expect(weeks[0]!.sessions.map((session) => session.date)).not.toContain("2025-12-13");
    const blockEasy = weeks
      .flatMap((week) => week.sessions)
      .filter((s) => s.type === "easy" && between(s.date, "2025-12-13", "2025-12-19"))
      .map((s) => s.target.distanceM);
    expect(blockEasy.reduce((sum, m) => sum + m, 0)).toBeLessThan((blockEasy.length + 1) * minRunM);
  });

  it("runs every day of a down week the taper starts in: its first block leaves the day before the taper 20 min", () => {
    // A Tuesday marathon: the taper starts on the Tuesday of week 20, a down week of 57 600 m. Its first
    // block, 80% of the 72 km peak, lays out only that week's Thursday, Saturday and Sunday, so sized
    // alone it filled them to 56 721 m and left Monday 879 m, under 20 min, which then did not run.
    const tuesday = input({
      goal: {
        distanceKey: "marathon",
        raceDate: "2028-03-14",
        daysPerWeek: 4,
        longRunDay: "thu",
      },
      startDate: "2027-10-11",
      baseline: {
        weeklyVolumesM: [69_663, 15_000, 89_991, 15_002],
        longestRunM: 10_505,
        daysSinceLastRun: 5,
      },
      vdotSource: {
        origin: "entered",
        distanceM: 21_097.5,
        timeS: 8477,
        activityId: null,
        date: null,
      },
    });
    const result = generatePlan(tuesday);
    assertPlanKeepsEveryRule(tuesday, result);
    const { paces, weeks } = plan(tuesday);
    const weekTwenty = weeks[19]!;
    const monday = weekTwenty.sessions.find((session) => session.date === "2028-02-21");
    expect(weekTwenty.sessions).toHaveLength(4);
    expect(monday?.target.distanceM).toBeGreaterThanOrEqual(
      minRunDistanceM(bandMidpointSPerKm(paces.easy)),
    );
    expect(weekTwenty.distanceM).toBeLessThanOrEqual(57_600);
  });

  it("throws on an input the contract rejects, a start that is not a Monday", () => {
    expect(() => generatePlan(input({ startDate: "2026-10-06" }))).toThrow();
  });
});
