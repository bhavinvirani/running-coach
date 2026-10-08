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
import { stridesM } from "../rules/strides";
import { fillWeek, minRunDistanceM } from "../rules/week-fill";
import { generatePlan, planStartVolume } from "./generate";
import { closeRaceInputArb, fullRaceInputArb, planInputArb as inputArb } from "./plan-arbitraries";

const START = "2026-10-05"; // a Monday
const QUALITY_TYPES = new Set(["intervals", "tempo", "race_practice"]);
const HARD_TYPES = new Set(["long", "intervals", "tempo", "race_practice", "race"]);
const HARD_ZONES = new Set(["threshold", "interval", "repetition", "race"]);
const WORK_CAP = { threshold: 0.1, interval: 0.08, repetition: 0.05, race: 0.1 } as const;
const MIN_DAYS = { "5k": 3, "10k": 3, half: 3, marathon: 4 } as const;
const EPS = 1e-9;
const PRE_TAPER: ReadonlySet<string> = new Set(["base", "build", "peak"]);

/** 30% of the week from 4 runs, 40% at 3, 1.2/n of fewer (a taper week of fewer runs). */
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

/** A quality session's meters before fillWeek padded its warmup and cooldown. */
function unpaddedM(session: GeneratedSession, paces: PlanPaces): number {
  const padOf = (step: Step, baseS: number) =>
    step.distanceM === null
      ? 0
      : step.distanceM - Math.round((baseS * 1000) / midpoint(paces, "easy"));
  return (
    session.target.distanceM -
    padOf(session.steps[0] as Step, 900) -
    padOf(session.steps.at(-1) as Step, 600)
  );
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
  easyPaceSPerKm,
}: {
  weekM: number;
  longM: number;
  qualityM: readonly number[];
  daysPerWeek: number;
  minRunM: number;
  easyPaceSPerKm: number;
}): boolean {
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const easySlots = daysPerWeek - 1 - qualityM.length;
  if (weekM - sum(qualityM) - easySlots * minRunM < longM) return false;
  const restM = weekM - longM;
  // Which days and which week change only how the easy meters split, not how many are placed.
  const fill = fillWeek({
    restM,
    longM,
    qualityM,
    easyDays: Array.from({ length: easySlots }, (_, k) => k),
    afterLongDay: -1,
    weekNumber: 1,
    minRunM,
    easyPaceSPerKm,
    keepDays: true,
  });
  const padsM = fill.qualityPadM.map((pad) => pad.warmupM + pad.cooldownM);
  return sum(qualityM) + sum(padsM) + sum(fill.easyRunsM) === restM;
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

const RACE_M = { "5k": 5000, "10k": 10_000, half: 21_098, marathon: 42_195 } as const;

/** A week's share of the taper peak by its Thursday's days to the race; null before the taper. */
function weekShare(distanceKey: RaceDistanceKey, thursdayDaysOut: number): number | null {
  const marathon = distanceKey === "marathon";
  if (thursdayDaysOut <= 6) return 0.4;
  if (thursdayDaysOut <= 13) return marathon ? 0.6 : 0.7;
  return marathon && thursdayDaysOut <= 20 ? 0.8 : null;
}

/** A long run's cap as a share of the peak long run by its days to the race; null with none by days. */
function longRunShareByDays(distanceKey: RaceDistanceKey, daysOut: number): number | null {
  const marathon = distanceKey === "marathon";
  if (daysOut <= 5) return 0;
  if (daysOut <= 13) return marathon ? 0.6 : 0.7;
  return marathon && daysOut <= 20 ? 0.8 : null;
}

const nonRace = (sessions: readonly GeneratedSession[]) =>
  sessions.filter((s) => s.type !== "race");

/** The meters of a long run's marathon-pace finish, 0 with none. */
const finishOf = (session: GeneratedSession) =>
  counted(session.steps)
    .filter(({ step }) => step.kind === "run" && step.zone === "marathon")
    .reduce((sum, { step }) => sum + step.distanceM!, 0);
/** Strides: quick run steps in the repetition zone on an easy run. */
const hasStrides = (session: GeneratedSession) =>
  counted(session.steps).some(({ step }) => step.kind === "run" && step.zone === "repetition");
/** A week as the runner sees it, dates aside: each session's weekday, type and steps. */
const weekShape = (week: GeneratedWeek) =>
  JSON.stringify(week.sessions.map((s) => [weekdayOf(s.date), s.type, s.steps]));

/** Seconds of hard time: work in a hard zone, and runs outside the easy and race zones (strides, finishes). */
function hardSeconds(sessions: readonly GeneratedSession[], paces: PlanPaces): number {
  return sessions
    .flatMap((session) => counted(session.steps))
    .filter(
      ({ step }) =>
        (step.kind === "work" && HARD_ZONES.has(step.zone)) ||
        (step.kind === "run" && step.zone !== "easy" && step.zone !== "race"),
    )
    .reduce((sum, { step, times }) => sum + times * stepSeconds(step, paces), 0);
}

function workMeters(session: GeneratedSession, paces: PlanPaces): Map<string, number> {
  const work = new Map<string, number>();
  for (const { step, times } of counted(session.steps).filter(({ step }) => step.kind === "work")) {
    work.set(step.zone, (work.get(step.zone) ?? 0) + times * stepMeters(step, paces));
  }
  return work;
}

// --- the whole-plan property ----------------------------------------------------------------------

/**
 * The shares a week's own sessions keep: each quality session's work within T 10%, I 8%, R 5% and race
 * pace 10% of `weekM`, the long run within `share` of it (never cut below `floorM` before the taper) and
 * 150 min, no quality session past the long run, and 80% of the time of `easyOver` easy (strides and
 * finishes hard), when given.
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
    /** The long run the sessions stay under, null with none. */
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
    const work = workMeters(session, paces);
    expect(work.size, label).toBeGreaterThan(0);
    for (const [zone, workM] of work) {
      expect(workM, label).toBeLessThanOrEqual(
        WORK_CAP[zone as keyof typeof WORK_CAP] * weekM + EPS,
      );
    }
  }
  if (easyOver === null) return;
  const totalS = easyOver.reduce((sum, session) => sum + session.target.durationS, 0);
  expect(hardSeconds(easyOver, paces), label).toBeLessThanOrEqual(0.2 * totalS + EPS);
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
  const raceDate = goal.raceDate;
  const minRunM = Math.ceil((1200 * 1000) / midpoint(paces, "easy"));
  const longRunMaxM = Math.floor((9000 * 1000) / midpoint(paces, "easy"));
  const daysOut = (date: string) => (raceDate === null ? Infinity : daysBetween(date, raceDate));
  const shareOf = (week: GeneratedWeek) =>
    raceDate === null ? null : weekShare(distanceKey, daysOut(addDays(week.startDate, 3)));
  const raceBand = (week: GeneratedWeek) => shareOf(week) === 0.4;
  // The race week's own days: the 6 before the race, but a long run 6 days out, and the easy runs 7 to
  // 9 days out in a race-band week.
  const isRaceWeekDay = (session: GeneratedSession, week: GeneratedWeek) =>
    session.type !== "race" &&
    ((daysOut(session.date) <= 6 && session.type !== "long") ||
      (raceBand(week) && daysOut(session.date) <= 9));

  numbersIn(result.plan)
    .filter(([path]) => path !== ".vdot")
    .forEach(([path, value]) => expect(Number.isInteger(value), path).toBe(true));

  expect(result.plan.startDate).toBe(of.startDate);
  expect(result.plan.endDate).toBe(raceDate ?? addDays(of.startDate, 83));

  const sessions = weeks.flatMap((week) => week.sessions);
  const races = sessions.filter((session) => session.type === "race");
  expect(races.map((session) => session.date)).toEqual(raceDate === null ? [] : [raceDate]);

  // Week 1 runs the start volume the rule sets, unless its runs cannot hold it: then every easy run is
  // at its cap (85% of the long run, which 110% of the recent longest or its cap by days to the race
  // holds down) and the week holds what that allows.
  const start = planStartVolume(of);
  if (!start.ok) throw new Error("a plan has a start volume");
  if (start.warning !== null) expect(result.plan.warnings).toContainEqual(start.warning);
  const weekOne = weeks[0]!;
  const weekOneLong = weekOne.sessions.find((s) => s.type === "long");
  if (PRE_TAPER.has(weekOne.phase) && weekOne.distanceM !== start.startVolumeM) {
    expect(weekOne.distanceM, "week 1").toBeLessThan(start.startVolumeM);
  }
  if (
    PRE_TAPER.has(weekOne.phase) &&
    weekOne.distanceM !== start.startVolumeM &&
    weekOneLong !== undefined
  ) {
    const longM = weekOneLong.target.distanceM;
    const easyCapM = Math.max(Math.floor((17 * longM) / 20), Math.min(minRunM, longM));
    const easy = weekOne.sessions.filter((s) => s.type === "easy");
    expect(easy.length, "week 1").toBeGreaterThan(0);
    expect(easy.map((s) => s.target.distanceM)).toEqual(easy.map(() => easyCapM));
  }

  // The taper: the weeks with a share, the race week last; its peak the largest week before it.
  const preTaper = weeks.filter((week) => PRE_TAPER.has(week.phase));
  const peakM =
    preTaper.length === 0
      ? start.startVolumeM
      : Math.max(...preTaper.map((week) => week.distanceM));
  if (raceDate !== null) {
    expect(weeks.map((week) => shareOf(week) !== null)).toEqual(
      weeks.map((week) => !PRE_TAPER.has(week.phase)),
    );
    expect(weeks.at(-1)!.phase).toBe("race");
    expect(weeks.slice(0, -1).every((week) => week.phase !== "race")).toBe(true);
  }

  const seedM = Math.max(baseline.longestRunM, 5000);
  // Down weeks: a race plan's counted back from its taper (none before week 3, never in the 3 weeks
  // before it), a fitness plan's every 4th week.
  const firstTaperWeek = preTaper.length + 1;
  const isDown = (number: number) =>
    raceDate === null
      ? number % 4 === 0
      : number >= 3 && firstTaperWeek - number >= 4 && (firstTaperWeek - number) % 4 === 0;
  // A marathon-pace finish only on every second build or peak week that is not a down week.
  const finishWeeks = new Set<number>();
  preTaper
    .filter((week) => (week.phase === "build" || week.phase === "peak") && !isDown(week.number))
    .forEach((week, k) => {
      if (k % 2 === 0) finishWeeks.add(week.number);
    });
  const longDates = new Set(sessions.filter((s) => s.type === "long").map((s) => s.date));
  const longestByWeek: number[] = [];
  let previousNonDownM: number | null = null;
  let peakLongRunM: number | null = null;

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
    const runs = nonRace(week.sessions);
    for (const run of runs) {
      expect(run.target.distanceM, label).toBeLessThanOrEqual(Math.floor(longestRecent * 1.1));
    }
    longestByWeek.push(Math.max(0, ...runs.map((run) => run.target.distanceM)));

    // Long runs: on the long-run day, never in the last 5 days, within their cap by days to the race,
    // a share of the largest long run before this week (else the baseline's longest).
    const longDate = addDays(week.startDate, weekdaySchema.options.indexOf(goal.longRunDay));
    const longs = week.sessions.filter((session) => session.type === "long");
    expect(longs.length, label).toBeLessThanOrEqual(1);
    const dayCap = longRunShareByDays(distanceKey, daysOut(longDate));
    const peakBeforeM = peakLongRunM ?? seedM;
    // A long run whose cap by days to the race is under 20 min is not run: its day runs easy or
    // rests.
    const dropsLong = dayCap !== null && Math.floor(dayCap * peakBeforeM) < minRunM;
    for (const long of longs) {
      expect(long.date, label).toBe(longDate);
      expect(daysOut(long.date), label).toBeGreaterThanOrEqual(6);
      expect(raceBand(week), label).toBe(false);
      expect(dropsLong, label).toBe(false);
      if (dayCap !== null) {
        expect(long.target.distanceM, label).toBeLessThanOrEqual(Math.floor(dayCap * peakBeforeM));
      }
    }
    const longM = longs[0]?.target.distanceM ?? null;
    if (longM !== null) peakLongRunM = Math.max(peakLongRunM ?? 0, longM);

    // A finish: within 20% of its long run, whole 500 m from 1 to 5 km, only where the rule puts one.
    for (const session of week.sessions) {
      const finishM = finishOf(session);
      if (finishM === 0) continue;
      expect(session.type, label).toBe("long");
      expect(finishWeeks.has(week.number), label).toBe(true);
      expect(finishM % 500, label).toBe(0);
      expect(finishM, label).toBeGreaterThanOrEqual(1000);
      expect(finishM, label).toBeLessThanOrEqual(Math.min(5000, 0.2 * session.target.distanceM));
    }
    // Strides: once a week at most, on an easy run, never the day after a long run.
    const strides = week.sessions.filter(hasStrides);
    expect(strides.length, label).toBeLessThanOrEqual(1);
    for (const session of strides) {
      expect(session.type, label).toBe("easy");
      expect(longDates.has(addDays(session.date, -1)), label).toBe(false);
    }
    // The week's own easy runs: at most 85% of its long run (20 min where that is under it, never past
    // the long run), and those over 20 min never all equal unless every one is at that cap.
    const ownEasy = week.sessions.filter((s) => s.type === "easy" && !isRaceWeekDay(s, week));
    if (longM !== null) {
      const easyCapM = Math.max(Math.floor((17 * longM) / 20), Math.min(minRunM, longM));
      for (const run of ownEasy) {
        expect(run.target.distanceM, label).toBeLessThanOrEqual(easyCapM);
      }
      const overTwenty = ownEasy.map((s) => s.target.distanceM).filter((m) => m > minRunM);
      if (overTwenty.length >= 2 && overTwenty.every((m) => m === overTwenty[0])) {
        expect(overTwenty[0], `${label} easy runs all equal`).toBe(easyCapM);
      }
    }

    if (PRE_TAPER.has(week.phase)) {
      // A down week recovers to 80% of the week before as built; the others climb at most 10% over the
      // last week that was not a down week. No week loads exactly as the one before it.
      const previous = weeks[k - 1];
      if (previous !== undefined) {
        expect(weekShape(week), `${label} repeats the week before`).not.toBe(weekShape(previous));
      }
      if (isDown(week.number)) {
        expect(week.distanceM, label).toBeLessThanOrEqual(Math.floor(0.8 * previous!.distanceM));
      } else {
        if (previousNonDownM !== null) {
          expect(week.distanceM, label).toBeLessThanOrEqual(Math.floor(previousNonDownM * 1.1));
        }
        previousNonDownM = week.distanceM;
      }
      // A week before the taper runs every day asked for, its long run on its day unless its cap by
      // days to the race is under 20 min, and keeps its shares.
      expect(week.sessions.length, label).toBe(goal.daysPerWeek);
      expect(
        longs.map((s) => s.date),
        label,
      ).toEqual(dropsLong ? [] : [longDate]);
      assertShares(label, paces, {
        sessions: week.sessions,
        weekM: week.distanceM,
        share: shareFor(goal.daysPerWeek),
        floorM: baseline.longestRunM,
        longM,
        easyOver: week.sessions,
      });
      // The share never cuts the baseline's longest run in a week that can hold it (150 min, 110% of
      // the recent longest and the long run's cap by days to the race allowing).
      const canHoldBaselineLongest =
        longRunMaxM >= baseline.longestRunM &&
        Math.floor(longestRecent * 1.1) >= baseline.longestRunM &&
        (dayCap === null || baseline.longestRunM <= Math.floor(dayCap * peakBeforeM)) &&
        holdsLongRun({
          weekM: week.distanceM,
          longM: baseline.longestRunM,
          qualityM: week.sessions
            .filter((session) => QUALITY_TYPES.has(session.type))
            .map((session) => unpaddedM(session, paces)),
          daysPerWeek: goal.daysPerWeek,
          minRunM,
          easyPaceSPerKm: midpoint(paces, "easy"),
        });
      if (canHoldBaselineLongest && !dropsLong)
        expect(longM!, label).toBeGreaterThanOrEqual(baseline.longestRunM);
      return;
    }

    // A taper week: under its share of the peak and never over the week before as built, the race
    // excluded. Its ceiling is the smaller of the two; a taper week runs something unless that is
    // under 20 min.
    const weekM = sumM(nonRace(week.sessions));
    const ceilingM = Math.min(
      Math.floor(shareOf(week)! * peakM),
      k > 0 ? sumM(nonRace(weeks[k - 1]!.sessions)) : Infinity,
    );
    expect(weekM, label).toBeLessThanOrEqual(ceilingM);
    if (week.phase === "taper" && week.sessions.length === 0) {
      expect(ceilingM, `${label} is empty`).toBeLessThan(minRunM);
    }
    const own = week.sessions.filter((s) => s.type !== "race" && !isRaceWeekDay(s, week));
    if (raceBand(week)) {
      // A race-band week holds only the race week's days and the race, and its easy runs 7 to 9
      // days out whenever one more fits: 2 at most, on a day of its own after the plan's start, in
      // a week of fewer runs than the days asked for, at 20 min beside every easy run at 20 min
      // under its ceiling.
      expect(own, label).toEqual([]);
      const extras = week.sessions.filter((s) => daysOut(s.date) >= 7);
      const openExtraDays = [7, 8, 9]
        .map((d) => addDays(raceDate!, -d))
        .filter(
          (date) =>
            between(date, week.startDate, addDays(week.startDate, 6)) &&
            daysBetween(of.startDate, date) >= 0 &&
            !week.sessions.some((s) => s.date === date),
        );
      if (
        extras.length < 2 &&
        openExtraDays.length > 0 &&
        week.sessions.length < goal.daysPerWeek
      ) {
        const shortestM = week.sessions.reduce(
          (sum, s) =>
            sum +
            (s.type === "easy" && daysOut(s.date) !== 2
              ? Math.min(s.target.distanceM, minRunM)
              : s.target.distanceM),
          0,
        );
        expect(shortestM + minRunM, `${label} leaves out an extra easy run`).toBeGreaterThan(
          ceilingM,
        );
      }
      return;
    }
    // Its own days: the long run on its day while 6 days out or more, unless its cap by days to the
    // race or what the race week's days leave of the ceiling is under 20 min; race practice until 7
    // days out, tempo until 10, no intervals or repetitions; the shares of the whole week; 80% easy
    // over the whole week, the race week's days in it included.
    const leftM = ceilingM - sumM(week.sessions.filter((s) => isRaceWeekDay(s, week)));
    if (own.length > 0 && daysOut(longDate) >= 6 && !dropsLong && leftM >= minRunM) {
      expect(
        longs.map((s) => s.date),
        label,
      ).toEqual([longDate]);
    }
    for (const session of own.filter((s) => QUALITY_TYPES.has(s.type))) {
      expect(["race_practice", "tempo"], label).toContain(session.type);
      expect(daysOut(session.date), label).toBeGreaterThanOrEqual(
        session.type === "tempo" ? 10 : 7,
      );
    }
    assertShares(`${label} own days`, paces, {
      sessions: own,
      weekM,
      share: shareFor(runs.length),
      floorM: 0,
      longM,
      easyOver: runs,
    });
    // A taper week wholly before the race week's days runs every day asked for, but where its easy runs
    // cannot take another 20 min run (fillWeek), as when its share is short of 20 min on each day.
    if (daysOut(addDays(week.startDate, 6)) >= 7 && runs.length < goal.daysPerWeek) {
      const easy = runs.filter((s) => s.type === "easy");
      expect(sumM(easy), `${label} runs ${runs.length} days`).toBeLessThan(
        (easy.length + 1) * minRunM,
      );
    }
  });

  // 48 h between hard days, across week boundaries too.
  const hardDates = sessions
    .filter((session) => HARD_TYPES.has(session.type))
    .map((session) => session.date);
  hardDates
    .slice(1)
    .forEach((date, k) => expect(daysBetween(hardDates[k]!, date)).toBeGreaterThanOrEqual(2));

  if (raceDate === null) return;
  // The 6 days before the race: rest the day before, one race practice at most, 3 or 4 days out, the
  // other days easy, no more than the days asked for less the race, under 40% of the taper peak, 80%
  // easy (the strides hard), the practice's work within 10% of them with the race.
  const lastSix = weeks.flatMap((week) => week.sessions.filter((s) => isRaceWeekDay(s, week)));
  const window = lastSix.filter((s) => daysOut(s.date) <= 6);
  expect(window.map((s) => s.date)).not.toContain(addDays(raceDate, -1));
  expect(window.length).toBeLessThanOrEqual(goal.daysPerWeek - 1);
  expect(sumM(window)).toBeLessThanOrEqual(0.4 * peakM + EPS);
  const practice = window.filter((s) => s.type !== "easy");
  expect(practice.length).toBeLessThanOrEqual(1);
  for (const session of practice) {
    expect(session.type).toBe("race_practice");
    expect([3, 4]).toContain(daysOut(session.date));
    for (const [zone, workM] of workMeters(session, paces)) {
      expect(zone).toBe("race");
      expect(workM).toBeLessThanOrEqual(0.1 * (sumM(window) + RACE_M[distanceKey]) + EPS);
    }
  }
  // They hold a run whenever 40% of the taper peak holds the primer, 20 min and 4 strides, on a day
  // of the plan.
  if (
    daysBetween(of.startDate, addDays(raceDate, -2)) >= 0 &&
    Math.floor(0.4 * peakM) >= minRunM + stridesM(4, paces)
  ) {
    expect(window.length, "the 6 days before the race run nothing").toBeGreaterThan(0);
  }
  const windowS = window.reduce((sum, session) => sum + session.target.durationS, 0);
  expect(hardSeconds(window, paces)).toBeLessThanOrEqual(0.2 * windowS + EPS);
  // The easy runs 7 to 9 days out in a race-band week: 2 at most.
  expect(lastSix.filter((s) => daysOut(s.date) >= 7).every((s) => s.type === "easy")).toBe(true);
  expect(lastSix.filter((s) => daysOut(s.date) >= 7).length).toBeLessThanOrEqual(2);
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

  it("tapers a race on every weekday by calendar week: 2 weeks, 3 for a Monday to Wednesday race, a marathon one more", () => {
    fc.assert(
      fc.property(fullRaceInputArb, (of) => {
        const result = generatePlan(of);
        assertPlanKeepsEveryRule(of, result);
        fc.pre(result.ok);
        if (!result.ok) return;
        const early = ["mon", "tue", "wed"].includes(weekdayOf(of.goal.raceDate!));
        const taperWeeks = (of.goal.distanceKey === "marathon" ? 3 : 2) + (early ? 1 : 0);
        expect(
          result.plan.weeks.filter((week) => week.phase === "taper" || week.phase === "race"),
        ).toHaveLength(taperWeeks);
      }),
      { numRuns: 200 },
    );
    // Each plan searches the week its days need through the week builder: a few seconds in all.
  }, 60_000);

  it("keeps every rule for races 1 to 5 weeks out on every weekday, plans that start in the taper", () => {
    fc.assert(
      fc.property(closeRaceInputArb, (of) => assertPlanKeepsEveryRule(of, generatePlan(of))),
      { numRuns: 300 },
    );
  }, 60_000);

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

  it("sizes a down week from the week before as built: a half from an 8 km longest runs weeks 1 to 5 at 32 560, 35 564, 28 451, 38 396 and 42 235 m", () => {
    // The 110% run cap holds the long run, and the easy run's 85% of it holds weeks 1 and 2, under the
    // curve; week 3, 16 weeks before the taper, recovers to 80% of week 2 as run, and weeks 4 and 5 climb
    // 10% over the last week that was not a down week.
    const capped = input({
      goal: { distanceKey: "half", raceDate: addDays(START, 7 * 20 - 1) },
      baseline: { weeklyVolumesM: [40_000, 40_000, 40_000, 40_000], longestRunM: 8000 },
    });
    assertPlanKeepsEveryRule(capped, generatePlan(capped));
    expect(
      plan(capped)
        .weeks.slice(0, 5)
        .map((week) => week.distanceM),
    ).toEqual([32_560, 35_564, 28_451, 38_396, 42_235]);
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
    // A 20:00 5K runs easy at 320 s/km, so 120 min is 22.5 km. At 4 days the peak week holds 70 435 m as
    // built (its easy run at 85% of the long run, warm-ups and cool-downs at 25 min), and 30% is 21.1 km.
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
      peakLongRunM: 21_130,
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

  it("tapers the seeded half by week: 70% with race practice 12 days out, tempo 10 and the long run 7, then 35 min, race practice 4 days out and the primer", () => {
    const seeded = input({
      goal: {
        distanceKey: "half",
        raceDate: addDays(START, 7 * 20 - 1),
        daysPerWeek: 4,
        longRunDay: "sun",
        recentTime: { distanceKey: "10k", timeS: 3281 },
      },
      baseline: { weeklyVolumesM: [25_000, 28_000, 22_000, 30_000], longestRunM: 15_000 },
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
    const raceDate = seeded.goal.raceDate!;
    expect(weeks.map((week) => week.phase).slice(-4)).toEqual(["peak", "peak", "taper", "race"]);
    const peakM = Math.max(...weeks.slice(0, -2).map((week) => week.distanceM));
    const peakLongM = Math.max(
      ...weeks
        .slice(0, -2)
        .flatMap((week) => week.sessions.filter((s) => s.type === "long"))
        .map((s) => s.target.distanceM),
    );
    const byDaysOut = (week: GeneratedWeek) =>
      week.sessions.map((s) => [daysBetween(s.date, raceDate), s.type]);

    const weekBefore = weeks.at(-2)!;
    expect(byDaysOut(weekBefore)).toEqual([
      [12, "race_practice"],
      [11, "easy"],
      [10, "tempo"],
      [7, "long"],
    ]);
    expect(weekBefore.distanceM).toBeLessThanOrEqual(0.7 * peakM);
    expect(weekBefore.sessions.at(-1)!.target.distanceM).toBeLessThanOrEqual(0.7 * peakLongM);

    const raceWeek = weeks.at(-1)!;
    expect(byDaysOut(raceWeek)).toEqual([
      [5, "easy"],
      [4, "race_practice"],
      [2, "easy"],
      [0, "race"],
    ]);
    const [easy, practice, primer] = raceWeek.sessions;
    // 35 min at the easy midpoint, in whole 500 m.
    expect(easy!.target.distanceM % 500).toBe(0);
    expect(easy!.target.durationS).toBeLessThanOrEqual(35 * 60);
    expect(easy!.target.durationS).toBeGreaterThan(
      35 * 60 - (500 * midpoint(paces, "easy")) / 1000,
    );
    expect(practice!.steps).toEqual([
      { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
      {
        repeat: 3,
        steps: [
          { kind: "work", zone: "race", distanceM: 1000, durationS: null },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 120 },
        ],
      },
      { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
    ]);
    expect(primer!.steps).toEqual([
      {
        kind: "run",
        zone: "easy",
        distanceM: Math.ceil((1200 * 1000) / midpoint(paces, "easy")),
        durationS: null,
      },
      {
        repeat: 4,
        steps: [
          { kind: "run", zone: "repetition", distanceM: null, durationS: 20 },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 60 },
        ],
      },
    ]);
    expect(sumM(nonRace(raceWeek.sessions))).toBeLessThanOrEqual(0.4 * peakM);
    // Hard days 48, 48, 72, 72 and 96 h apart from the last peak week's long run to the race.
    const hard = weeks
      .slice(-3)
      .flatMap((week) => week.sessions)
      .filter((s) => HARD_TYPES.has(s.type))
      .map((s) => s.date)
      .slice(-6);
    expect(hard.slice(1).map((date, k) => daysBetween(hard[k]!, date))).toEqual([2, 2, 3, 3, 4]);
  });

  it("varies the seeded half: down weeks 15, 11, 7 and 3, a finish every second build week, strides on the latest easy run, peak sessions swapping order", () => {
    const seeded = input({
      goal: {
        distanceKey: "half",
        raceDate: addDays(START, 7 * 20 - 1),
        daysPerWeek: 4,
        longRunDay: "sun",
        recentTime: { distanceKey: "10k", timeS: 3281 },
      },
      baseline: { weeklyVolumesM: [25_000, 28_000, 22_000, 30_000], longestRunM: 15_000 },
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
    const { weeks } = plan(seeded);
    const week = (number: number) => weeks[number - 1]!;
    // The taper starts in week 19: the weeks 4, 8, 12 and 16 before it recover to 80%.
    for (const number of [3, 7, 11, 15]) {
      expect(week(number).distanceM, `week ${number}`).toBeLessThanOrEqual(
        Math.floor(0.8 * week(number - 1).distanceM),
      );
    }
    for (const number of [16, 17, 18]) {
      expect(week(number).distanceM, `week ${number}`).toBeGreaterThan(
        0.8 * week(number - 1).distanceM,
      );
    }
    // The first build week ends its long run with 2.5 km at marathon pace (20% of 15 km is 3 km, which
    // the 80% rule cuts once); the next build week does not.
    const longOf = (number: number) => week(number).sessions.find((s) => s.type === "long")!;
    expect(longOf(5).steps.at(-1)).toEqual({
      kind: "run",
      zone: "marathon",
      distanceM: 2500,
      durationS: null,
    });
    expect(longOf(6).steps).toHaveLength(1);
    // A base week's strides go on Friday's easy run, not Monday's, the day after Sunday's long run.
    expect(
      week(2)
        .sessions.filter(hasStrides)
        .map((s) => weekdayOf(s.date)),
    ).toEqual(["fri"]);
    // Peak weeks swap race practice and tempo by week.
    const quality = (number: number) =>
      week(number)
        .sessions.filter((s) => QUALITY_TYPES.has(s.type))
        .map((s) => s.type);
    expect(quality(17)).toEqual(["race_practice", "tempo"]);
    expect(quality(18)).toEqual(["tempo", "race_practice"]);
    // The midweek easy run stays under the long run: at most 85% of it.
    for (const number of [9, 13, 17]) {
      const easy = week(number).sessions.find((s) => s.type === "easy")!;
      expect(easy.target.distanceM, `week ${number}`).toBeLessThanOrEqual(
        Math.floor((17 * longOf(number).target.distanceM) / 20),
      );
    }
  });

  it("tapers a Sunday marathon on 5 days to 80%, 60%, then the race week's 40%, the long runs to 80% and 60% of the peak one", () => {
    const marathon = input({
      goal: { distanceKey: "marathon", raceDate: addDays(START, 7 * 20 - 1), daysPerWeek: 5 },
      baseline: { weeklyVolumesM: [33_000, 36_000, 34_000, 35_000], longestRunM: 14_000 },
    });
    const result = generatePlan(marathon);
    assertPlanKeepsEveryRule(marathon, result);
    const { weeks } = plan(marathon);
    expect(weeks.map((week) => week.phase).slice(-5)).toEqual([
      "peak",
      "peak",
      "taper",
      "taper",
      "race",
    ]);
    const peakM = Math.max(...weeks.slice(0, -3).map((week) => week.distanceM));
    const longOf = (week: GeneratedWeek) =>
      week.sessions.find((s) => s.type === "long")?.target.distanceM ?? null;
    const peakLongM = Math.max(...weeks.slice(0, -3).map((week) => longOf(week) ?? 0));
    const [threeOut, twoOut, raceWeek] = weeks.slice(-3);
    expect(threeOut!.distanceM).toBeLessThanOrEqual(0.8 * peakM);
    expect(twoOut!.distanceM).toBeLessThanOrEqual(0.6 * peakM);
    expect(twoOut!.distanceM).toBeLessThanOrEqual(threeOut!.distanceM);
    expect(sumM(nonRace(raceWeek!.sessions))).toBeLessThanOrEqual(0.4 * peakM);
    expect(longOf(threeOut!)).toBeLessThanOrEqual(0.8 * peakLongM);
    expect(longOf(twoOut!)).toBeLessThanOrEqual(0.6 * peakLongM);
    expect(longOf(raceWeek!)).toBeNull();
  });

  it("tapers a Monday race in 3 weeks: 70%, then a 40% week holding the race week's days, then the race alone", () => {
    const raceDate = addDays(START, 7 * 14);
    const monday = input({
      goal: { distanceKey: "half", raceDate, daysPerWeek: 4 },
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
    // The week before: 30 min 7 days out, 35 min 5 days out, race practice 4, the primer 2, rest the
    // Sunday before; no long run.
    expect(weeks.at(-2)!.sessions.map((s) => [daysBetween(s.date, raceDate), s.type])).toEqual([
      [7, "easy"],
      [5, "easy"],
      [4, "race_practice"],
      [2, "easy"],
    ]);
  });

  it("rests the Monday before a Tuesday race and runs the primer on the Sunday", () => {
    const raceDate = addDays(START, 7 * 14 + 1);
    const tuesday = input({
      goal: { distanceKey: "10k", raceDate, daysPerWeek: 5 },
      baseline: { weeklyVolumesM: [30_000, 30_000, 30_000, 30_000], longestRunM: 12_000 },
    });
    const result = generatePlan(tuesday);
    assertPlanKeepsEveryRule(tuesday, result);
    const { weeks } = plan(tuesday);
    expect(weeks.at(-1)!.sessions.map((session) => session.type)).toEqual(["race"]);
    const weekBefore = weeks.at(-2)!.sessions;
    expect(weekBefore.at(-1)).toMatchObject({ date: addDays(raceDate, -2), type: "easy" });
    expect(weekBefore.filter((s) => s.type === "long")).toEqual([]);
  });

  it("gives a Wednesday race's 40% week easy runs 9 and 7 days out, 35 min 5 days out and race practice 4, the primer on race week's Monday", () => {
    const raceDate = addDays(START, 7 * 14 + 2);
    const wednesday = input({
      goal: { distanceKey: "half", raceDate, daysPerWeek: 4 },
      baseline: { weeklyVolumesM: [30_000, 30_000, 30_000, 30_000], longestRunM: 15_000 },
    });
    const result = generatePlan(wednesday);
    assertPlanKeepsEveryRule(wednesday, result);
    const { weeks } = plan(wednesday);
    const days = (week: GeneratedWeek) =>
      week.sessions.map((s) => [daysBetween(s.date, raceDate), s.type]);
    expect(days(weeks.at(-2)!)).toEqual([
      [9, "easy"],
      [7, "easy"],
      [5, "easy"],
      [4, "race_practice"],
    ]);
    expect(days(weeks.at(-1)!)).toEqual([
      [2, "easy"],
      [0, "race"],
    ]);
    // The week before that tapers to 70%: its long run 10 days out.
    expect(weeks.at(-3)!.phase).toBe("taper");
    expect(days(weeks.at(-3)!)).toContainEqual([10, "long"]);
  });

  it("puts a Thursday race's practice on the Sunday before, 4 days out, inside its 70% week", () => {
    const raceDate = addDays(START, 7 * 14 + 3);
    const thursday = input({
      goal: { distanceKey: "half", raceDate, daysPerWeek: 4 },
      baseline: { weeklyVolumesM: [30_000, 30_000, 30_000, 30_000], longestRunM: 15_000 },
    });
    const result = generatePlan(thursday);
    assertPlanKeepsEveryRule(thursday, result);
    const { weeks } = plan(thursday);
    expect(weeks.map((week) => week.phase).slice(-4)).toEqual(["peak", "peak", "taper", "race"]);
    const lastSix = weeks
      .flatMap((week) => week.sessions)
      .filter((s) => between(s.date, addDays(raceDate, -6), addDays(raceDate, -1)));
    expect(lastSix.map((s) => [daysBetween(s.date, raceDate), s.type])).toContainEqual([
      4,
      "race_practice",
    ]);
    expect(lastSix.filter((s) => s.type === "long")).toEqual([]);
    expect(lastSix.map((s) => s.date)).not.toContain(addDays(raceDate, -1));
  });

  it("keeps the long run 6 days out and drops it 5 days out: a Saturday and a Friday race after a Sunday long run", () => {
    const longRunSixOut = (raceWeekday: number) => {
      const raceDate = addDays(START, 7 * 14 + raceWeekday);
      const of = input({
        goal: { distanceKey: "10k", raceDate, daysPerWeek: 4, longRunDay: "sun" },
        baseline: { weeklyVolumesM: [30_000, 30_000, 30_000, 30_000], longestRunM: 12_000 },
      });
      assertPlanKeepsEveryRule(of, generatePlan(of));
      const sunday = addDays(START, 7 * 14 - 1);
      return (
        plan(of)
          .weeks.at(-2)!
          .sessions.find((s) => s.date === sunday) ?? null
      );
    };
    expect(longRunSixOut(5)).toMatchObject({ type: "long" });
    expect(longRunSixOut(4)?.type).not.toBe("long");
  });

  it("starts a plan inside the taper at its week's share of the start volume, with race_date_close", () => {
    // A Sunday half 13 days out: week 1's Thursday is 10 days out, so it runs at most 70% of week 1's
    // start volume; a Wednesday race 9 days out starts in its 40% week.
    for (const daysOut of [13, 9]) {
      const close = input({ goal: { distanceKey: "half", raceDate: addDays(START, daysOut) } });
      const result = generatePlan(close);
      assertPlanKeepsEveryRule(close, result);
      const start = planStartVolume(close);
      const { weeks, warnings } = plan(close);
      expect(weeks.map((week) => week.phase)).toEqual(["taper", "race"]);
      expect(warnings).toContainEqual({ code: "race_date_close", weeks: 2, minimumWeeks: 12 });
      expect(weeks[0]!.distanceM).toBeLessThanOrEqual(
        (daysOut === 13 ? 0.7 : 0.4) * (start.ok ? start.startVolumeM : 0),
      );
    }
  });

  it("moves race practice to 3 days out when the plan starts after 4 days out: a Thursday race in week 1", () => {
    const raceDate = addDays(START, 3);
    const thursday = input({ goal: { distanceKey: "5k", raceDate, daysPerWeek: 4 } });
    const result = generatePlan(thursday);
    assertPlanKeepsEveryRule(thursday, result);
    expect(
      plan(thursday).weeks[0]!.sessions.map((s) => [daysBetween(s.date, raceDate), s.type]),
    ).toEqual([
      [3, "race_practice"],
      [2, "easy"],
      [0, "race"],
    ]);
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
    expect(half.engineVersion).toBe("0.6.0");
    expect(half.weeks.at(-1)!.sessions.at(-1)!.steps).toEqual([
      { kind: "run", zone: "race", distanceM: 21_098, durationS: null },
    ]);
  });

  it("rests the Sunday before a Monday 5K on 3 days and runs no long run in its 40% week", () => {
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
    expect(weekBefore.sessions.map((session) => session.date)).not.toContain(
      addDays(START, 7 * 13 - 1),
    );
  });

  it("keeps every rule for seed 131140314, a 5K 3 weeks out on 5 days from no runs: week 1 runs all 5, its Sunday 2 weeks out", () => {
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

  it("keeps every rule for a Saturday half 3 weeks out on 6 days and a Tuesday marathon whose taper starts on week 20", () => {
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
    assertPlanKeepsEveryRule(saturday, generatePlan(saturday));
    const tuesday = input({
      goal: { distanceKey: "marathon", raceDate: "2028-03-14", daysPerWeek: 4, longRunDay: "thu" },
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
    assertPlanKeepsEveryRule(tuesday, generatePlan(tuesday));
    const { weeks } = plan(tuesday);
    expect(weeks.map((week) => week.phase).slice(-4)).toEqual(["taper", "taper", "taper", "race"]);
    expect(weeks[19]!.startDate).toBe("2028-02-21");
    expect(weeks[19]!.phase).toBe("taper");
  });

  it("never leaves the 6 days before a Monday 10K empty on 3 days from 10 km weeks: race practice of 1 x 1 km and 20 min 5 days out", () => {
    // The primer does not fit beside race practice under 40% of the taper peak, so 5 days out takes
    // its day, and the practice keeps the 6 days 80% easy beside it.
    const raceDate = "2026-12-07";
    const monday = input({
      goal: { distanceKey: "10k", raceDate, daysPerWeek: 3, longRunDay: "sun" },
      baseline: { weeklyVolumesM: [10_000, 10_000, 10_000, 10_000], longestRunM: 3500 },
      vdotSource: { origin: "entered", distanceM: 5000, timeS: 1800, activityId: null, date: null },
    });
    const result = generatePlan(monday);
    assertPlanKeepsEveryRule(monday, result);
    const raceBandWeek = plan(monday).weeks.at(-2)!;
    expect(raceBandWeek.sessions.map((s) => [daysBetween(s.date, raceDate), s.type])).toEqual([
      [5, "easy"],
      [4, "race_practice"],
    ]);
  });

  it("keeps a Wednesday 10K's easy runs 9 and 7 days out on 5 days when 5 and 3 days out do not fit beside race practice and the primer", () => {
    const raceDate = "2026-12-02";
    const wednesday = input({
      goal: { distanceKey: "10k", raceDate, daysPerWeek: 5, longRunDay: "sun" },
      startDate: "2026-10-12",
      baseline: { weeklyVolumesM: [25_000, 28_000, 22_000, 30_000], longestRunM: 15_000 },
      vdotSource: { origin: "entered", distanceM: 5000, timeS: 1200, activityId: null, date: null },
    });
    const result = generatePlan(wednesday);
    assertPlanKeepsEveryRule(wednesday, result);
    const raceBandWeek = plan(wednesday).weeks.at(-2)!;
    expect(raceBandWeek.sessions.map((s) => [daysBetween(s.date, raceDate), s.type])).toEqual([
      [9, "easy"],
      [7, "easy"],
      [4, "race_practice"],
    ]);
  });

  it("keeps a taper week under its ceiling when the race week's days fill it: no long run where they leave under 20 min, a marathon 10 days out", () => {
    const close = input({
      goal: { distanceKey: "marathon", raceDate: "2026-10-22", daysPerWeek: 4, longRunDay: "wed" },
      startDate: "2026-10-12",
      baseline: { weeklyVolumesM: [12_000, 12_000, 12_000, 12_000], longestRunM: 5000 },
    });
    const result = generatePlan(close);
    assertPlanKeepsEveryRule(close, result);
    const start = planStartVolume(close);
    const weekOne = plan(close).weeks[0]!;
    expect(weekOne.distanceM).toBeLessThanOrEqual(
      Math.floor(0.6 * (start.ok ? start.startVolumeM : 0)),
    );
    expect(weekOne.sessions.some((s) => s.type === "long")).toBe(false);
  });

  it("runs no long run where its cap by days to the race is under 20 min, and fewer 20 min easy runs instead of 10 min ones: a 5K 17 days out from no runs", () => {
    // Week 1's long run is a 20 min run, so week 2's would be capped at 70% of it, 6 days out.
    const close = input({
      goal: { distanceKey: "5k", raceDate: "2026-10-29", daysPerWeek: 5, longRunDay: "fri" },
      startDate: "2026-10-12",
      baseline: { weeklyVolumesM: [0, 0, 0, 0], longestRunM: 0 },
      vdotSource: {
        origin: "entered",
        distanceM: 10_000,
        timeS: 2700,
        activityId: null,
        date: null,
      },
    });
    const result = generatePlan(close);
    assertPlanKeepsEveryRule(close, result);
    const { paces, weeks } = plan(close);
    const minRunM = minRunDistanceM(bandMidpointSPerKm(paces.easy));
    expect(weeks[1]!.phase).toBe("taper");
    expect(weeks[1]!.sessions.some((s) => s.type === "long")).toBe(false);
    for (const s of weeks.flatMap((week) => week.sessions).filter((s) => s.type === "easy")) {
      expect(s.target.distanceM).toBeGreaterThanOrEqual(minRunM);
    }
  });

  it("treats a target slower than the easy band's slow end as no target: the same plan and week 1, so week 1's search ends where it does without one", () => {
    const slowTargets: PlanGenerationInput[] = [
      {
        goal: {
          kind: "race",
          distanceKey: "5k",
          raceDate: "2027-07-09",
          targetTimeS: 16_443,
          daysPerWeek: 4,
          longRunDay: "mon",
          recentTime: { distanceKey: "half", timeS: 18_819 },
        },
        startDate: "2027-07-05",
        baseline: {
          weeklyVolumesM: [8, 71_667, 102_063, 96_722],
          longestRunM: 29_960,
          daysSinceLastRun: 17,
        },
        vdotSource: {
          origin: "entered",
          distanceM: 42_195,
          timeS: 10_524,
          activityId: null,
          date: null,
        },
      },
      {
        goal: {
          kind: "race",
          distanceKey: "10k",
          raceDate: "2030-07-01",
          targetTimeS: 16_524,
          daysPerWeek: 5,
          longRunDay: "sun",
          recentTime: null,
        },
        startDate: "2030-06-24",
        baseline: {
          weeklyVolumesM: [78_129, 119_989, 101_907, 66_288],
          longestRunM: 34_891,
          daysSinceLastRun: 56,
        },
        vdotSource: {
          origin: "race",
          distanceM: 10_000,
          timeS: 2185,
          activityId: null,
          date: null,
        },
      },
    ];
    for (const slow of slowTargets) {
      const untargeted = { ...slow, goal: { ...slow.goal, targetTimeS: null } };
      assertPlanKeepsEveryRule(slow, generatePlan(slow));
      expect(planStartVolume(slow)).toEqual(planStartVolume(untargeted));
      expect(generatePlan(slow)).toEqual(generatePlan(untargeted));
      expect(generatePlan(slow).ok).toBe(true);
    }
  });

  it("throws on an input the contract rejects, a start that is not a Monday", () => {
    expect(() => generatePlan(input({ startDate: "2026-10-06" }))).toThrow();
  });
});
