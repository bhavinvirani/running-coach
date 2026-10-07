import {
  sessionStatusSchema,
  sessionStepsSchema,
  type PlanPaces,
  type SessionSteps,
  type SessionType,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, weekdayIndex, weekdayOf } from "../dates";
import {
  reEntryPlan,
  type ReEntryChange,
  type ReEntryInput,
  type ReEntrySession,
} from "./re-entry-plan";
import { sessionTarget } from "./session-target";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // midpoint 320 s/km: 20 min is 3750 m
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 },
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 223 },
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};
const QUALITY = new Set<SessionType>(["intervals", "tempo", "race_practice"]);
const MIN_RUN_M = 3750;

const easyRun = (distanceM: number): SessionSteps => [
  { kind: "run", zone: "easy", distanceM, durationS: null },
];
// 12 503 m in 3570 s.
const intervals = (reps: number): SessionSteps => [
  { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
  {
    repeat: reps,
    steps: [
      { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
      { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
    ],
  },
  { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
];
const walkRun = (reps: number): SessionSteps => [
  {
    repeat: reps,
    steps: [
      { kind: "run", zone: "easy", distanceM: null, durationS: 240 },
      { kind: "recovery", zone: "easy", distanceM: null, durationS: 60 },
    ],
  },
];

function session(
  date: string,
  type: SessionType = "easy",
  distanceM = 8000,
  overrides: Partial<ReEntrySession> = {},
): ReEntrySession {
  const steps = overrides.steps ?? (QUALITY.has(type) ? intervals(5) : easyRun(distanceM));
  return {
    id: `${date}-${type}`,
    date,
    type,
    status: "planned",
    source: "plan",
    title: null,
    ...overrides,
    steps,
    target: sessionTarget(steps, PACES),
  };
}

/** Tuesday and Thursday easy 8 km, Sunday long 14 km: 30 km a week from the Monday given. */
function week(monday: string): ReEntrySession[] {
  return [
    session(addDays(monday, 1)),
    session(addDays(monday, 3)),
    session(addDays(monday, 6), "long", 14_000),
  ];
}

const MONDAYS = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"];
const PLAN = MONDAYS.flatMap(week);

function reEnter(overrides: Partial<ReEntryInput>) {
  return reEntryPlan({
    fromDate: "2026-10-12",
    daysOff: 10,
    walkRun: false,
    sessions: PLAN,
    paces: PACES,
    ...overrides,
  });
}

/** Each changed session's id and its one run step's meters. */
const metersById = (changes: readonly ReEntryChange[]) =>
  changes.map(({ id, session: changed }) => [id, changed.target.distanceM]);

describe("re-entry plan", () => {
  it("changes nothing after 6 days off taken while well", () => {
    expect(reEnter({ daysOff: 6 })).toEqual({ factor: 1, changes: [] });
  });

  it.each([
    [7, 0.7, 5600, 9800],
    [13, 0.7, 5600, 9800],
    [14, 0.5, 4000, 7000],
  ])("starts %s days off at %s of the first week", (daysOff, factor, easyM, longM) => {
    const result = reEnter({ daysOff });
    expect(result.factor).toBe(factor);
    expect(metersById(result.changes).slice(0, 3)).toEqual([
      ["2026-10-13-easy", easyM],
      ["2026-10-15-easy", easyM],
      ["2026-10-18-long", longM],
    ]);
  });

  it("raises each later week at most 10% over the one before until it meets the plan", () => {
    // Targets 21 000, 23 100, 25 410, 27 951 m of 30 000, then the plan's 30 000: weeks 1 to 4 change.
    expect(metersById(reEnter({ daysOff: 10 }).changes)).toEqual([
      ["2026-10-13-easy", 5600],
      ["2026-10-15-easy", 5600],
      ["2026-10-18-long", 9800],
      ["2026-10-20-easy", 6100],
      ["2026-10-22-easy", 6100],
      ["2026-10-25-long", 10_700],
      ["2026-10-27-easy", 6700],
      ["2026-10-29-easy", 6700],
      ["2026-11-01-long", 11_800],
      ["2026-11-03-easy", 7400],
      ["2026-11-05-easy", 7400],
      ["2026-11-08-long", 13_000],
    ]);
  });

  it("scales a session's steps and keeps its type, title and status", () => {
    const [first] = reEnter({ daysOff: 10 }).changes;
    expect(first).toEqual({
      id: "2026-10-13-easy",
      session: {
        type: "easy",
        title: null,
        status: "planned",
        steps: easyRun(5600),
        target: { distanceM: 5600, durationS: 1792, zone: "easy" },
      },
    });
  });

  it("turns quality into an easy run of the same time in the first 7 days back, then cuts reps after", () => {
    const sessions = [
      session("2026-10-15", "tempo"),
      session("2026-10-18", "long", 14_000),
      session("2026-10-20", "intervals"),
      session("2026-10-25", "long", 14_000),
    ];
    const { changes } = reEnter({ sessions });
    // Week 1 targets 70% of 26 503 m; the tempo is 11 100 m easy, cut to 7700.
    expect(changes[0]!.session).toMatchObject({ type: "easy", steps: easyRun(7700) });
    expect(changes[1]!.session.steps).toEqual(easyRun(9800));
    // Week 2 targets 77%: 5 x 1000 m keeps round(3.85) = 4 reps.
    expect(changes[2]!.session).toMatchObject({ type: "intervals", steps: intervals(4) });
    expect(changes[3]!.session.steps).toEqual(easyRun(10_700));
  });

  it("illness or injury: the first 7 days are walk-run, 4 min run and 1 min walk, at full time after 3 days off", () => {
    const sessions = [
      session("2026-10-14"),
      session("2026-10-15", "tempo"),
      session("2026-10-18", "long", 15_000),
      session("2026-10-20"),
      session("2026-10-21"),
    ];
    const result = reEntryPlan({
      fromDate: "2026-10-14",
      daysOff: 3,
      walkRun: true,
      sessions,
      paces: PACES,
    });
    expect(result.factor).toBe(1);
    expect(result.changes.map((c) => c.id)).toEqual([
      "2026-10-14-easy",
      "2026-10-15-tempo",
      "2026-10-18-long",
      "2026-10-20-easy",
    ]);
    // 2560 s of easy is 8 x 5 min; the tempo's 3552 s easy 11; the long run's 4800 s 16.
    expect(result.changes[0]!.session).toEqual({
      type: "easy",
      title: "Walk-run",
      status: "planned",
      steps: walkRun(8),
      target: { distanceM: 7504, durationS: 2400, zone: "easy" },
    });
    expect(result.changes.map((c) => c.session.steps)).toEqual([
      walkRun(8),
      walkRun(11),
      walkRun(16),
      walkRun(8),
    ]);
  });

  it("illness or injury after 14 days off: walk-run from the halved session's time", () => {
    const { changes } = reEntryPlan({
      fromDate: "2026-10-14",
      daysOff: 14,
      walkRun: true,
      sessions: [session("2026-10-14"), session("2026-10-21")],
      paces: PACES,
    });
    // 4000 m is 1280 s: 4 x 5 min. A week later the run is cut to 55% and stays a run.
    expect(changes.map((c) => c.session.steps)).toEqual([walkRun(4), easyRun(4400)]);
  });

  it("gives a walk-run at least 2 and at most 50 rounds", () => {
    const { changes } = reEntryPlan({
      fromDate: "2026-10-14",
      daysOff: 0,
      walkRun: true,
      sessions: [session("2026-10-14", "easy", 1500), session("2026-10-15", "long", 60_000)],
      paces: PACES,
    });
    expect(changes.map((c) => c.session.steps)).toEqual([walkRun(2), walkRun(50)]);
  });

  it("changes nothing on a second return over a walk-run week it already made", () => {
    const input: ReEntryInput = {
      fromDate: "2026-10-14",
      daysOff: 2,
      walkRun: true,
      sessions: [session("2026-10-14"), session("2026-10-16")],
      paces: PACES,
    };
    const first = reEntryPlan(input);
    const after = input.sessions.map((s) => ({
      ...s,
      ...first.changes.find((c) => c.id === s.id)!.session,
    }));
    expect(reEntryPlan({ ...input, sessions: after }).changes).toEqual([]);
  });

  it("missed or moved sessions: never touches sessions before the return, the race, custom workouts or done, missed or skipped ones; eases a moved one", () => {
    const sessions = [
      session("2026-10-13"),
      session("2026-10-14", "race", 10_000),
      session("2026-10-15", "easy", 8000, { source: "custom", id: "custom" }),
      session("2026-10-15", "easy", 8000, { status: "done", id: "done" }),
      session("2026-10-16", "easy", 8000, { status: "missed", id: "missed" }),
      session("2026-10-16", "easy", 8000, { status: "skipped", id: "skipped" }),
      session("2026-10-16", "strength", 0, { steps: [], id: "strength" }),
      session("2026-10-18", "long", 14_000, { status: "moved" }),
    ];
    const { changes } = reEnter({ fromDate: "2026-10-14", sessions });
    expect(changes).toMatchObject([
      { id: "2026-10-18-long", session: { status: "moved", steps: easyRun(9800) } },
    ]);
  });

  it("illness or injury pause: the days the pause skipped still count in the first week's base", () => {
    // Back on Thursday after 9 days off: the skipped Tuesday is planned volume of week 1, so week 2
    // targets 110% of 70% of 30 000 m, not of the 22 000 m left.
    const sessions = [
      session("2026-10-13", "easy", 8000, { status: "skipped" }),
      ...PLAN.filter((s) => daysBetween("2026-10-15", s.date) >= 0).slice(0, 5),
    ];
    const { changes } = reEnter({ fromDate: "2026-10-15", daysOff: 9, sessions });
    expect(metersById(changes)).toEqual([
      ["2026-10-15-easy", 5600],
      ["2026-10-18-long", 9800],
      ["2026-10-20-easy", 6100],
      ["2026-10-22-easy", 6100],
      ["2026-10-25-long", 10_700],
    ]);
  });

  it("starts at the first week with sessions when the return falls before the plan", () => {
    const { changes } = reEnter({ fromDate: "2026-10-08", sessions: week("2026-10-12") });
    expect(metersById(changes)).toEqual([
      ["2026-10-13-easy", 5600],
      ["2026-10-15-easy", 5600],
      ["2026-10-18-long", 9800],
    ]);
  });

  it("counts a custom workout in its week's volume but never changes it", () => {
    const sessions = [
      ...week("2026-10-12"),
      ...week("2026-10-19"),
      session("2026-10-24", "easy", 10_000, { source: "custom", id: "custom" }),
    ];
    // Week 2 targets 23 100 of 40 000 m: the plan's runs at 57.75%.
    expect(metersById(reEnter({ sessions }).changes).slice(3)).toEqual([
      ["2026-10-20-easy", 4600],
      ["2026-10-22-easy", 4600],
      ["2026-10-25-long", 8000],
    ]);
  });

  it("lists the changes in date order whatever order the sessions came in", () => {
    const shuffled = [...PLAN].reverse();
    const ids = reEnter({ sessions: shuffled }).changes.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("rejects days off that are not a whole number >= 0 as a programmer error", () => {
    expect(() => reEnter({ daysOff: -1 })).toThrow(RangeError);
  });

  // --- properties over generated sessions ---------------------------------------------------------

  const FIRST_MONDAY = "2026-10-12";
  const inputArb: fc.Arbitrary<ReEntryInput> = fc
    .record({
      sessions: fc.array(
        fc.record({
          dayOffset: fc.integer({ min: 0, max: 41 }),
          type: fc.constantFrom<SessionType>(
            "easy",
            "long",
            "intervals",
            "tempo",
            "race_practice",
            "race",
            "strength",
          ),
          distanceM: fc.integer({ min: 1000, max: 35_000 }),
          reps: fc.integer({ min: 2, max: 10 }),
          status: fc.constantFrom(...sessionStatusSchema.options),
          custom: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
        }),
        { maxLength: 30 },
      ),
      fromOffset: fc.integer({ min: -3, max: 30 }),
      daysOff: fc.nat({ max: 30 }),
      walkRun: fc.boolean(),
    })
    .map((drawn) => ({
      fromDate: addDays(FIRST_MONDAY, drawn.fromOffset),
      daysOff: drawn.daysOff,
      walkRun: drawn.walkRun,
      paces: PACES,
      sessions: drawn.sessions.map((s, k) =>
        session(addDays(FIRST_MONDAY, s.dayOffset), s.type, s.distanceM, {
          id: `s${k}`,
          status: s.status,
          source: s.custom ? "custom" : "plan",
          steps: QUALITY.has(s.type)
            ? intervals(s.reps)
            : s.type === "strength"
              ? []
              : easyRun(s.distanceM),
        }),
      ),
    }));

  const eligible = (input: ReEntryInput, s: ReEntrySession) =>
    s.source === "plan" &&
    (s.status === "planned" || s.status === "moved") &&
    daysBetween(input.fromDate, s.date) >= 0 &&
    s.type !== "race" &&
    s.type !== "strength";
  const mondayOf = (date: string) => addDays(date, -weekdayIndex(weekdayOf(date)));
  const inFirstDays = (input: ReEntryInput, date: string) => daysBetween(input.fromDate, date) < 7;

  /** The spec's week ratios: 70% or 50% of week 1, up 10% a week, until a week meets its plan. */
  function ratios(input: ReEntryInput): Map<string, number> {
    const plannedM = new Map<string, number>();
    for (const s of input.sessions) {
      const counts =
        daysBetween(input.fromDate, s.date) < 0 ||
        (s.status !== "skipped" && s.status !== "missed");
      const monday = mondayOf(s.date);
      if (counts && daysBetween(mondayOf(input.fromDate), monday) >= 0) {
        plannedM.set(monday, (plannedM.get(monday) ?? 0) + s.target.distanceM);
      }
    }
    const factor = input.daysOff >= 14 ? 0.5 : input.daysOff >= 7 ? 0.7 : 1;
    const out = new Map<string, number>();
    let targetM: number | null = null;
    for (const [monday, p] of [...plannedM].sort(([a], [b]) => daysBetween(b, a))) {
      if (p === 0) continue;
      targetM = targetM === null ? factor * p : Math.min(p, targetM * 1.1);
      if (targetM / p >= 1) break;
      out.set(monday, targetM / p);
    }
    return out;
  }

  it("only changes plan runs from the return on, planned or moved, never the race, in date order", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = reEntryPlan(input);
        const byId = new Map(input.sessions.map((s) => [s.id, s]));
        const dates = result.changes.map((c) => byId.get(c.id)!.date);
        expect(dates).toEqual([...dates].sort());
        for (const change of result.changes) {
          expect(eligible(input, byId.get(change.id)!)).toBe(true);
          expect(sessionStepsSchema.parse(change.session.steps)).toEqual(change.session.steps);
          expect(change.session.target).toEqual(sessionTarget(change.session.steps, PACES));
        }
        expect(reEntryPlan(input)).toEqual(result);
      }),
    );
  });

  it("cuts each easy or long run to its week's ratio, never under 20 min, and leaves weeks that meet the plan", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = reEntryPlan(input);
        const weekRatios = ratios(input);
        const changed = new Map(result.changes.map((c) => [c.id, c.session]));
        for (const s of input.sessions.filter((each) => eligible(input, each))) {
          const after = changed.get(s.id);
          const ratio = weekRatios.get(mondayOf(s.date));
          const converted = inFirstDays(input, s.date) && (input.walkRun || result.factor < 1);
          if (ratio === undefined && !converted) {
            expect(after, `${s.id} meets its plan`).toBeUndefined();
            continue;
          }
          if (after === undefined || after.title === "Walk-run") continue;
          expect(after.target.distanceM).toBeLessThanOrEqual(s.target.distanceM);
          if (QUALITY.has(after.type)) continue;
          expect(after.target.distanceM).toBeGreaterThanOrEqual(
            Math.min(s.target.distanceM, MIN_RUN_M),
          );
          if (!QUALITY.has(s.type) && ratio !== undefined) {
            expect(after.target.distanceM).toBeLessThanOrEqual(
              Math.max(ratio * s.target.distanceM + 1e-6, Math.min(s.target.distanceM, MIN_RUN_M)),
            );
          }
        }
      }),
    );
  });

  it("never lets a walk-run outlast the session it replaces, or 20 min when that was shorter", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const byId = new Map(input.sessions.map((s) => [s.id, s]));
        for (const change of reEntryPlan(input).changes) {
          if (change.session.title !== "Walk-run") continue;
          expect(input.walkRun).toBe(true);
          expect(inFirstDays(input, byId.get(change.id)!.date)).toBe(true);
          expect(change.session.target.durationS).toBeLessThanOrEqual(
            Math.max(byId.get(change.id)!.target.durationS, 1200),
          );
        }
      }),
    );
  });
});
