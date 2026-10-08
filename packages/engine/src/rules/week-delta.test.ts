import {
  planPhaseSchema,
  raceDistanceKeySchema,
  sessionStatusSchema,
  sessionStepsSchema,
  type PlanDelta,
  type PlanPhase,
  type PlanPaces,
  type SessionSteps,
  type SessionType,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween } from "../dates";
import { sessionTarget } from "./session-target";
import {
  validateWeekDeltas,
  type WeekDeltaContext,
  type WeekDeltaProposal,
  type WeekDeltaSession,
} from "./week-delta";
import { maxWeeklyVolumeM } from "./weekly-volume";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // midpoint 320 s/km: 20 min 3750 m
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 },
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 223 },
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};
const MONDAY = "2026-10-12"; // the coming week runs Monday 12 to Sunday 18 October
const QUALITY = new Set<SessionType>(["intervals", "tempo", "race_practice"]);

const easyRun = (distanceM: number): SessionSteps => [
  { kind: "run", zone: "easy", distanceM, durationS: null },
];
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

function weekSession(
  id: string,
  day: number,
  distanceM: number,
  overrides: Partial<WeekDeltaSession> = {},
): WeekDeltaSession {
  const steps = overrides.steps ?? easyRun(distanceM);
  return {
    id,
    date: addDays(MONDAY, day),
    type: "easy",
    status: "planned",
    source: "plan",
    title: null,
    coachAdjusted: false,
    eased: false,
    phase: "build",
    ...overrides,
    steps,
    target: overrides.target ?? sessionTarget(steps, PACES),
  };
}

// 31 500 m planned: s1 Tuesday 8000, s2 Thursday 9500, s3 Sunday 14 000 (an easy run, so only the
// weekly cap and 110% of the longest recent run apply to its rise).
const WEEK = [weekSession("s1", 1, 8000), weekSession("s2", 3, 9500), weekSession("s3", 6, 14_000)];

function context(overrides: Partial<WeekDeltaContext> = {}): WeekDeltaContext {
  return {
    today: MONDAY,
    sessions: WEEK,
    race: null,
    previousWeekM: null,
    longestRecentM: 20_000,
    daysPerWeek: 4,
    paces: PACES,
    paused: false,
    afterPause: false,
    ...overrides,
  };
}

const scale = (factor: number): PlanDelta => ({ kind: "scale", factor });
const propose = (sessionId: string | null, delta: PlanDelta): WeekDeltaProposal => ({
  sessionId,
  delta,
});

describe("validate week deltas", () => {
  it("caps two rises that each fit alone but not together: the later session clamps to the week's +10%", () => {
    // 30 000 m the week before allows 33 000: 1500 m of room over the planned 31 500.
    const ctx = context({ previousWeekM: 30_000 });
    expect(validateWeekDeltas(ctx, [propose("s1", scale(1.1))])).toMatchObject([
      { sessionId: "s1", result: { ok: true, clamped: false, session: { steps: easyRun(8800) } } },
    ]);
    expect(validateWeekDeltas(ctx, [propose("s3", scale(1.1))])).toMatchObject([
      {
        sessionId: "s3",
        result: { ok: true, clamped: false, session: { steps: easyRun(15_400) } },
      },
    ]);
    // Together: s1 takes 800 m, leaving s3 700 m (33 000 - 8800 - 9500 = 14 700).
    expect(validateWeekDeltas(ctx, [propose("s1", scale(1.1)), propose("s3", scale(1.1))])).toEqual(
      [
        {
          sessionId: "s1",
          result: {
            ok: true,
            delta: scale(1.1),
            clamped: false,
            session: {
              type: "easy",
              title: null,
              status: "planned",
              steps: easyRun(8800),
              target: { distanceM: 8800, durationS: 2816, zone: "easy" },
            },
          },
        },
        {
          sessionId: "s3",
          result: {
            ok: true,
            delta: scale(14_700 / 14_000),
            clamped: true,
            session: {
              type: "easy",
              title: null,
              status: "planned",
              steps: easyRun(14_700),
              target: { distanceM: 14_700, durationS: 4704, zone: "easy" },
            },
          },
        },
      ],
    );
  });

  it("decides in date order whatever order the coach listed them: reversed proposals give the same results", () => {
    const ctx = context({ previousWeekM: 30_000 });
    const proposals = [propose("s1", scale(1.1)), propose("s3", scale(1.1))];
    const forward = validateWeekDeltas(ctx, proposals);
    const reversed = validateWeekDeltas(ctx, [...proposals].reverse());
    expect(reversed).toEqual([...forward].reverse());
    expect(reversed[0]).toMatchObject({ sessionId: "s3", result: { clamped: true } });
  });

  it("rejects a proposal for a null or unknown session with no_session and still decides the rest", () => {
    expect(
      validateWeekDeltas(context(), [
        propose(null, { kind: "rest" }),
        propose("s9", { kind: "rest" }),
        propose("s2", { kind: "rest" }),
      ]),
    ).toEqual([
      { sessionId: null, result: { ok: false, reason: "no_session" } },
      { sessionId: "s9", result: { ok: false, reason: "no_session" } },
      {
        sessionId: "s2",
        result: {
          ok: true,
          delta: { kind: "rest" },
          clamped: false,
          session: {
            type: "easy",
            title: null,
            status: "skipped",
            steps: easyRun(9500),
            target: WEEK[1]!.target,
          },
        },
      },
    ]);
  });

  it("rejects a second proposal for the same session as adjusted, accepted or not: the first listed wins", () => {
    expect(
      validateWeekDeltas(context(), [propose("s1", scale(0.8)), propose("s1", { kind: "rest" })]),
    ).toMatchObject([
      { sessionId: "s1", result: { ok: true, session: { steps: easyRun(6400) } } },
      { sessionId: "s1", result: { ok: false, reason: "adjusted" } },
    ]);
    // Not locked: a session the first proposal rested is still judged as it came in.
    expect(
      validateWeekDeltas(context(), [propose("s1", { kind: "rest" }), propose("s1", scale(0.8))]),
    ).toMatchObject([
      { sessionId: "s1", result: { ok: true, session: { status: "skipped" } } },
      { sessionId: "s1", result: { ok: false, reason: "adjusted" } },
    ]);
    // easy leaves an easy run as it is, and still uses up the session's one change.
    expect(
      validateWeekDeltas(context(), [propose("s1", { kind: "easy" }), propose("s1", scale(0.8))]),
    ).toEqual([
      { sessionId: "s1", result: { ok: false, reason: "no_change" } },
      { sessionId: "s1", result: { ok: false, reason: "adjusted" } },
    ]);
  });

  it("rests one session and scales another: a rest earlier in the week makes room for a later rise", () => {
    // 28 000 m the week before allows 30 800, under the planned 31 500: alone, s3 cannot rise.
    const ctx = context({ previousWeekM: 28_000 });
    expect(validateWeekDeltas(ctx, [propose("s3", scale(1.1))])).toEqual([
      { sessionId: "s3", result: { ok: false, reason: "no_change" } },
    ]);
    // Resting s1 leaves 30 800 - 9500 = 21 300 for s3: its 15 400 fits.
    expect(
      validateWeekDeltas(ctx, [propose("s3", scale(1.1)), propose("s1", { kind: "rest" })]),
    ).toMatchObject([
      {
        sessionId: "s3",
        result: { ok: true, clamped: false, session: { steps: easyRun(15_400) } },
      },
      { sessionId: "s1", result: { ok: true, session: { status: "skipped" } } },
    ]);
  });

  it("rejects a change to a session the coach or a review already changed as adjusted", () => {
    const sessions = [weekSession("s1", 1, 8000, { coachAdjusted: true }), WEEK[1]!];
    expect(
      validateWeekDeltas(context({ sessions }), [
        propose("s1", { kind: "rest" }),
        propose("s2", { kind: "rest" }),
      ]),
    ).toMatchObject([
      { sessionId: "s1", result: { ok: false, reason: "adjusted" } },
      { sessionId: "s2", result: { ok: true } },
    ]);
  });

  it("illness or injury pauses: a session a re-entry eased only shrinks", () => {
    const sessions = [
      weekSession("s1", 1, 8000, { eased: true }),
      weekSession("s2", 3, 9500, { eased: true }),
      WEEK[2]!,
    ];
    expect(
      validateWeekDeltas(context({ sessions }), [
        propose("s1", scale(1.1)),
        propose("s2", scale(0.8)),
        propose("s3", scale(1.1)),
      ]),
    ).toMatchObject([
      { sessionId: "s1", result: { ok: false, reason: "no_change" } },
      { sessionId: "s2", result: { ok: true, session: { steps: easyRun(7600) } } },
      { sessionId: "s3", result: { ok: true, session: { steps: easyRun(15_400) } } },
    ]);
  });

  it("illness or injury pauses: during a pause every proposal for the week's sessions is rejected paused", () => {
    expect(
      validateWeekDeltas(context({ paused: true }), [
        propose("s1", { kind: "rest" }),
        propose("s2", scale(0.8)),
        propose("s3", scale(1.1)),
        propose("s1", { kind: "rest" }),
      ]),
    ).toEqual(
      ["s1", "s2", "s3", "s1"].map((sessionId) => ({
        sessionId,
        result: { ok: false, reason: "paused" },
      })),
    );
  });

  it("illness or injury pauses: right after a paused week rises clamp to no change and cuts still apply", () => {
    expect(
      validateWeekDeltas(context({ afterPause: true, previousWeekM: 30_000 }), [
        propose("s1", scale(1.1)),
        propose("s2", scale(0.8)),
        propose("s3", scale(1.3)),
      ]),
    ).toMatchObject([
      { sessionId: "s1", result: { ok: false, reason: "no_change" } },
      { sessionId: "s2", result: { ok: true, clamped: false, session: { steps: easyRun(7600) } } },
      { sessionId: "s3", result: { ok: false, reason: "no_change" } },
    ]);
  });

  it.each(["taper", "race"] as const)(
    "a %s week's sessions only shrink: rises by 1.01 and 1.1 change nothing, a cut by 0.8 applies",
    (phase) => {
      const sessions = WEEK.map((session) => ({ ...session, phase }));
      expect(
        validateWeekDeltas(context({ sessions }), [
          propose("s1", scale(1.1)),
          propose("s2", scale(0.8)),
          propose("s3", scale(1.01)),
        ]),
      ).toMatchObject([
        { sessionId: "s1", result: { ok: false, reason: "no_change" } },
        {
          sessionId: "s2",
          result: { ok: true, clamped: false, session: { steps: easyRun(7600) } },
        },
        { sessionId: "s3", result: { ok: false, reason: "no_change" } },
      ]);
    },
  );

  it("reads each session's own phase: a peak-week session rises next to a taper-week one", () => {
    // Not a week the plan makes, but the phase travels with each session, not with the week.
    const sessions = [
      { ...WEEK[0]!, phase: "taper" as const },
      { ...WEEK[1]!, phase: "peak" as const },
    ];
    expect(
      validateWeekDeltas(context({ sessions }), [
        propose("s1", scale(1.1)),
        propose("s2", scale(1.1)),
      ]),
    ).toMatchObject([
      { sessionId: "s1", result: { ok: false, reason: "no_change" } },
      { sessionId: "s2", result: { ok: true, session: { steps: easyRun(10_400) } } },
    ]);
  });

  it("only shrinks a peak week's long run 13 days before a half, and grows one 14 days before it", () => {
    // 37 500 m of other runs hold a 10 000 m long run's rise to 11 000 m under 30% of the week.
    const sessions = [
      ...WEEK.slice(0, 2),
      weekSession("s4", 5, 20_000, { phase: "peak" }),
      weekSession("s3", 6, 10_000, { type: "long", phase: "peak" }),
    ];
    const reviewed = (daysOut: number) =>
      validateWeekDeltas(
        context({
          sessions,
          race: { date: addDays(MONDAY, 6 + daysOut), distanceKey: "half" },
        }),
        [propose("s3", scale(1.1)), propose("s4", scale(1.1))],
      );
    expect(reviewed(13)).toMatchObject([
      { sessionId: "s3", result: { ok: false, reason: "no_change" } },
      { sessionId: "s4", result: { ok: true, session: { steps: easyRun(22_000) } } },
    ]);
    expect(reviewed(14)).toMatchObject([
      { sessionId: "s3", result: { ok: true, session: { steps: easyRun(11_000) } } },
      { sessionId: "s4", result: { ok: true, session: { steps: easyRun(22_000) } } },
    ]);
  });

  it("clamps a rise of 1.3 to 1.1 and says so", () => {
    expect(validateWeekDeltas(context(), [propose("s1", scale(1.3))])).toMatchObject([
      {
        sessionId: "s1",
        result: { ok: true, delta: scale(1.1), clamped: true, session: { steps: easyRun(8800) } },
      },
    ]);
  });

  it("missed or moved sessions: a past or missed session stays locked and a moved one still changes", () => {
    // Reviewed late, on the Wednesday: Tuesday's session is past.
    const sessions = [
      weekSession("s1", 1, 8000, { status: "missed" }),
      weekSession("s2", 0, 6000),
      weekSession("s3", 3, 9500, { status: "moved" }),
    ];
    expect(
      validateWeekDeltas(context({ today: addDays(MONDAY, 2), sessions }), [
        propose("s1", { kind: "rest" }),
        propose("s2", { kind: "rest" }),
        propose("s3", { kind: "rest" }),
      ]),
    ).toMatchObject([
      { sessionId: "s1", result: { ok: false, reason: "locked" } },
      { sessionId: "s2", result: { ok: false, reason: "locked" } },
      { sessionId: "s3", result: { ok: true, session: { status: "skipped" } } },
    ]);
  });

  it("turns a quality session easy and never grows one", () => {
    const sessions = [weekSession("q1", 2, 0, { type: "intervals", steps: intervals(5) })];
    expect(
      validateWeekDeltas(context({ sessions }), [propose("q1", { kind: "easy" })]),
    ).toMatchObject([
      { sessionId: "q1", result: { ok: true, session: { type: "easy", steps: easyRun(11_100) } } },
    ]);
    expect(validateWeekDeltas(context({ sessions }), [propose("q1", scale(1.1))])).toEqual([
      { sessionId: "q1", result: { ok: false, reason: "no_change" } },
    ]);
  });

  it("returns nothing for no proposals", () => {
    expect(validateWeekDeltas(context(), [])).toEqual([]);
  });

  // --- properties over generated weeks and proposals ------------------------------------------------

  const typeArb = fc.constantFrom<SessionType>(
    "easy",
    "long",
    "intervals",
    "tempo",
    "race_practice",
    "race",
  );
  const counts = (status: string) => status !== "skipped" && status !== "missed";
  /** true about one draw in `n`. */
  const oneIn = (n: number) => fc.noBias(fc.integer({ min: 1, max: n })).map((k) => k === 1);
  // Mostly open easy runs of the plan, and a week before near this week's total, so changes land and
  // the weekly cap binds; every type, status and source still turns up.
  const sessionArb = fc.record({
    type: fc.oneof(
      { weight: 4, arbitrary: fc.constant<SessionType>("easy") },
      { weight: 1, arbitrary: typeArb },
    ),
    distanceM: fc.integer({ min: 2000, max: 20_000 }),
    reps: fc.integer({ min: 2, max: 12 }),
    status: fc.oneof(
      { weight: 6, arbitrary: fc.constant("planned" as const) },
      { weight: 1, arbitrary: fc.constantFrom(...sessionStatusSchema.options) },
    ),
    source: fc.oneof(
      { weight: 8, arbitrary: fc.constant("plan" as const) },
      { weight: 1, arbitrary: fc.constant("custom" as const) },
    ),
    day: fc.noBias(fc.integer({ min: 0, max: 6 })),
    coachAdjusted: oneIn(8),
    eased: oneIn(8),
  });
  const deltaArb: fc.Arbitrary<PlanDelta> = fc.oneof(
    { weight: 3, arbitrary: fc.double({ min: 1, max: 1.4, noNaN: true }).map(scale) },
    { weight: 1, arbitrary: fc.double({ min: -1, max: 3, noNaN: true }).map(scale) },
    { weight: 1, arbitrary: fc.constant({ kind: "easy" as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: "rest" as const }) },
  );
  const drawnArb = fc
    .record({
      sessions: fc.array(sessionArb, { minLength: 3, maxLength: 9 }),
      todayOffset: fc.oneof(
        { weight: 3, arbitrary: fc.constant(0) },
        { weight: 1, arbitrary: fc.integer({ min: -1, max: 3 }) },
      ),
      // null, 0, or a share of this week's planned total: under 0.91 the week is over its cap already,
      // up to 1 it leaves 0 to 10% of room.
      previousWeek: fc.oneof(
        { weight: 1, arbitrary: fc.constant(null) },
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 8, arbitrary: fc.noBias(fc.double({ min: 0.88, max: 1, noNaN: true })) },
      ),
      longestRecentM: fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 5, arbitrary: fc.integer({ min: 15_000, max: 40_000 }) },
      ),
      daysPerWeek: fc.integer({ min: 3, max: 7 }),
      paused: oneIn(10),
      afterPause: oneIn(6),
      phase: fc.constantFrom<PlanPhase>(...planPhaseSchema.options),
      race: fc.option(
        fc.record({
          daysOut: fc.integer({ min: 0, max: 30 }),
          distanceKey: fc.constantFrom(...raceDistanceKeySchema.options),
        }),
      ),
      proposals: fc.array(
        fc.record({
          pick: fc.oneof(
            { weight: 1, arbitrary: fc.constant(null) },
            { weight: 1, arbitrary: fc.constant(-1) },
            { weight: 8, arbitrary: fc.noBias(fc.nat({ max: 999 })) },
          ),
          delta: deltaArb,
        }),
        { minLength: 1, maxLength: 6 },
      ),
    })
    .map((drawn) => {
      const sessions = drawn.sessions.map((s, k) =>
        weekSession(`s${k}`, s.day, s.distanceM, {
          type: s.type,
          status: s.status,
          source: s.source,
          coachAdjusted: s.coachAdjusted,
          eased: s.eased,
          phase: s.source === "custom" ? null : drawn.phase,
          steps: QUALITY.has(s.type)
            ? intervals(s.reps)
            : [
                {
                  kind: "run",
                  zone: s.type === "race" ? "race" : "easy",
                  distanceM: s.distanceM,
                  durationS: null,
                },
              ],
        }),
      );
      const plannedM = sessions
        .filter((session) => counts(session.status))
        .reduce((sum, session) => sum + session.target.distanceM, 0);
      const ctx = context({
        today: addDays(MONDAY, drawn.todayOffset),
        sessions,
        previousWeekM:
          drawn.previousWeek === null || drawn.previousWeek === 0
            ? drawn.previousWeek
            : Math.max(1, Math.round(drawn.previousWeek * plannedM)),
        longestRecentM: drawn.longestRecentM,
        daysPerWeek: drawn.daysPerWeek,
        paused: drawn.paused,
        afterPause: drawn.afterPause,
        race:
          drawn.race === null
            ? null
            : { date: addDays(MONDAY, drawn.race.daysOut), distanceKey: drawn.race.distanceKey },
      });
      const proposals = drawn.proposals.map(({ pick, delta }) =>
        propose(pick === null ? null : pick < 0 ? "none" : `s${pick % sessions.length}`, delta),
      );
      return { ctx, proposals };
    });

  it("keeps the week within +10% of the week before over all accepted changes together, one outcome per proposal in their order, and never grows a taper or race-week session or a long run inside the taper's bands", () => {
    fc.assert(
      fc.property(drawnArb, ({ ctx, proposals }) => {
        const outcomes = validateWeekDeltas(ctx, proposals);
        expect(validateWeekDeltas(ctx, proposals)).toEqual(outcomes);
        expect(outcomes.map((o) => o.sessionId)).toEqual(proposals.map((p) => p.sessionId));

        const after = new Map(ctx.sessions.map((s) => [s.id, { ...s }]));
        for (const { sessionId, result } of outcomes) {
          if (!result.ok) continue;
          const before = ctx.sessions.find((s) => s.id === sessionId)!;
          expect(after.get(sessionId!)).toEqual(before); // at most one accepted change per session
          expect(sessionStepsSchema.parse(result.session.steps)).toEqual(result.session.steps);
          after.set(sessionId!, { ...before, ...result.session });
        }
        const totalM = (sessions: Iterable<WeekDeltaSession>) =>
          [...sessions]
            .filter((s) => counts(s.status))
            .reduce((sum, s) => sum + s.target.distanceM, 0);
        const plannedM = totalM(ctx.sessions);
        if (ctx.previousWeekM !== null && ctx.previousWeekM > 0) {
          expect(totalM(after.values())).toBeLessThanOrEqual(
            Math.max(plannedM, maxWeeklyVolumeM(ctx.previousWeekM)),
          );
        }
        if (ctx.paused) {
          for (const { result } of outcomes) expect(result.ok).toBe(false);
        }
        for (const s of ctx.sessions) {
          const shrinkOnly =
            ctx.paused ||
            ctx.afterPause ||
            ctx.previousWeekM === 0 ||
            ctx.longestRecentM === 0 ||
            s.phase === "taper" ||
            s.phase === "race" ||
            (s.type === "long" &&
              ctx.race !== null &&
              daysBetween(s.date, ctx.race.date) <=
                (ctx.race.distanceKey === "marathon" ? 20 : 13));
          if (shrinkOnly) {
            expect(after.get(s.id)!.target.distanceM).toBeLessThanOrEqual(s.target.distanceM);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("gives the same outcome for each proposal whatever their order, when they name distinct sessions on distinct dates", () => {
    fc.assert(
      fc.property(drawnArb, ({ ctx, proposals }) => {
        const named = proposals.flatMap((p) => {
          const s = ctx.sessions.find((session) => session.id === p.sessionId);
          return s === undefined ? [] : [s];
        });
        fc.pre(new Set(named.map((s) => s.date)).size === named.length);
        const forward = validateWeekDeltas(ctx, proposals);
        const reversed = validateWeekDeltas(ctx, [...proposals].reverse());
        expect(reversed).toEqual([...forward].reverse());
      }),
      { numRuns: 300 },
    );
  });
});
