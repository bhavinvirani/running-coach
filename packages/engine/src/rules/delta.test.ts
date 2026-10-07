import {
  planPhaseSchema,
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
import type { DeltaSession } from "./apply-delta";
import { validateDelta, type DeltaContext, type DeltaWeekSession } from "./delta";
import { sessionTarget } from "./session-target";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // midpoint 320 s/km: 20 min 3750 m, 150 min 28 125 m
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 },
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 223 },
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};
const TODAY = "2026-10-07"; // a Wednesday
const TOMORROW = "2026-10-08";
const QUALITY = new Set<SessionType>(["intervals", "tempo", "race_practice"]);

const easyRun = (distanceM: number): SessionSteps => [
  { kind: "run", zone: "easy", distanceM, durationS: null },
];
// 20 s strides at repetition pace and a 60 s jog: 91 + 188 m a round.
const withStrides = (runM: number, repeat: number): SessionSteps => [
  { kind: "run", zone: "easy", distanceM: runM, durationS: null },
  {
    repeat,
    steps: [
      { kind: "run", zone: "repetition", distanceM: null, durationS: 20 },
      { kind: "recovery", zone: "easy", distanceM: null, durationS: 60 },
    ],
  },
];
const withFinish = (easyM: number, finishM: number): SessionSteps => [
  { kind: "run", zone: "easy", distanceM: easyM, durationS: null },
  { kind: "run", zone: "marathon", distanceM: finishM, durationS: null },
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

function session(overrides: Partial<DeltaSession> = {}): DeltaSession {
  const steps = overrides.steps ?? easyRun(8000);
  return {
    date: TOMORROW,
    type: "easy",
    status: "planned",
    source: "plan",
    title: null,
    ...overrides,
    steps,
    target: overrides.target ?? sessionTarget(steps, PACES),
  };
}

const long = (distanceM: number) => session({ type: "long", steps: easyRun(distanceM) });

function other(
  distanceM: number,
  status: DeltaWeekSession["status"] = "planned",
  type: SessionType = "easy",
): DeltaWeekSession {
  return { date: "2026-10-06", type, status, target: sessionTarget(easyRun(distanceM), PACES) };
}

function context(overrides: Partial<DeltaContext> = {}): DeltaContext {
  return {
    today: TODAY,
    session: session(),
    phase: null,
    weekSessions: [],
    previousWeekM: null,
    longestRecentM: 20_000,
    daysPerWeek: 4,
    paces: PACES,
    paused: false,
    coachAdjusted: false,
    eased: false,
    afterPause: false,
    ...overrides,
  };
}

const scale = (factor: number): PlanDelta => ({ kind: "scale", factor });

/** The accepted result's steps, or a failure naming why it was rejected. */
function stepsOf(ctx: DeltaContext, delta: PlanDelta) {
  const result = validateDelta(ctx, delta);
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result;
}

describe("validate delta", () => {
  it("rejects with no_session when nothing is planned after the run, before any other check", () => {
    expect(validateDelta(context({ session: null, paused: true }), { kind: "rest" })).toEqual({
      ok: false,
      reason: "no_session",
    });
  });

  it("rejects with paused during a pause, before a custom workout", () => {
    expect(
      validateDelta(context({ paused: true, session: session({ source: "custom" }) }), {
        kind: "rest",
      }),
    ).toEqual({ ok: false, reason: "paused" });
  });

  it("rejects a custom workout, before a race", () => {
    expect(
      validateDelta(context({ session: session({ source: "custom", type: "race" }) }), {
        kind: "rest",
      }),
    ).toEqual({ ok: false, reason: "custom" });
  });

  it("never changes a race, even one already locked", () => {
    expect(
      validateDelta(context({ session: session({ type: "race", status: "done" }) }), {
        kind: "rest",
      }),
    ).toEqual({ ok: false, reason: "race" });
  });

  it.each(["done", "missed", "skipped"] as const)("locks a %s session", (status) => {
    expect(validateDelta(context({ session: session({ status }) }), { kind: "rest" })).toEqual({
      ok: false,
      reason: "locked",
    });
  });

  it("locks a past session: planned yesterday is locked, planned today is not", () => {
    expect(
      validateDelta(context({ session: session({ date: addDays(TODAY, -1) }) }), { kind: "rest" }),
    ).toEqual({ ok: false, reason: "locked" });
    expect(validateDelta(context({ session: session({ date: TODAY }) }), { kind: "rest" }).ok).toBe(
      true,
    );
  });

  it("missed or moved sessions: changes a moved session, never a missed one", () => {
    expect(
      validateDelta(context({ session: session({ status: "moved" }) }), { kind: "rest" }),
    ).toMatchObject({ ok: true, session: { status: "skipped" } });
  });

  it("rejects a session the coach already changed, before checking the factor", () => {
    expect(validateDelta(context({ coachAdjusted: true }), scale(Number.NaN))).toEqual({
      ok: false,
      reason: "adjusted",
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a scale by %s as invalid",
    (factor) => {
      expect(validateDelta(context(), scale(factor))).toEqual({ ok: false, reason: "invalid" });
    },
  );

  it("rests a session: skipped, steps and target as planned, never clamped", () => {
    const planned = session();
    expect(validateDelta(context({ session: planned }), { kind: "rest" })).toEqual({
      ok: true,
      delta: { kind: "rest" },
      clamped: false,
      session: {
        type: "easy",
        title: null,
        status: "skipped",
        steps: planned.steps,
        target: planned.target,
      },
    });
  });

  it.each(["easy", "long"] as const)("rejects easy for a %s session as no_change", (type) => {
    expect(validateDelta(context({ session: session({ type }) }), { kind: "easy" })).toEqual({
      ok: false,
      reason: "no_change",
    });
  });

  it.each(["intervals", "tempo", "race_practice"] as const)(
    "turns a %s session into an easy run of the same time",
    (type) => {
      const result = stepsOf(context({ session: session({ type, steps: intervals(5) }) }), {
        kind: "easy",
      });
      // 900 + 5 x (234 + 180) + 600 s = 3570 s at 320 s/km is 11 156 m, floored to 11 100.
      expect(result).toEqual({
        ok: true,
        delta: { kind: "easy" },
        clamped: false,
        session: {
          type: "easy",
          title: null,
          status: "planned",
          steps: easyRun(11_100),
          target: { distanceM: 11_100, durationS: 3552, zone: "easy" },
        },
      });
    },
  );

  it("cuts an easy run by the factor", () => {
    expect(validateDelta(context(), scale(0.8))).toEqual({
      ok: true,
      delta: { kind: "scale", factor: 0.8 },
      clamped: false,
      session: {
        type: "easy",
        title: null,
        status: "planned",
        steps: easyRun(6400),
        target: { distanceM: 6400, durationS: 2048, zone: "easy" },
      },
    });
  });

  it.each([0.3, 0, -2])("clamps a cut by %s to 0.5", (factor) => {
    expect(validateDelta(context(), scale(factor))).toMatchObject({
      ok: true,
      delta: { kind: "scale", factor: 0.5 },
      clamped: true,
      session: { steps: easyRun(4000) },
    });
  });

  it("keeps the boundary factors 0.5 and 1.1 unclamped", () => {
    expect(validateDelta(context(), scale(0.5))).toMatchObject({
      clamped: false,
      session: { steps: easyRun(4000) },
    });
    expect(validateDelta(context(), scale(1.1))).toMatchObject({
      clamped: false,
      session: { steps: easyRun(8800) },
    });
  });

  it("clamps a rise above 1.1 to 1.1", () => {
    expect(validateDelta(context(), scale(1.5))).toMatchObject({
      ok: true,
      delta: { kind: "scale", factor: 1.1 },
      clamped: true,
      session: { steps: easyRun(8800) },
    });
  });

  it("stops a cut at the 20 min minimum run and says so", () => {
    expect(
      validateDelta(context({ session: session({ steps: easyRun(6000) }) }), scale(0.6)),
    ).toMatchObject({
      ok: true,
      delta: { kind: "scale", factor: 0.6 },
      clamped: true,
      session: { steps: easyRun(3750) },
    });
  });

  it("rejects a cut of a run already at the minimum as no_change", () => {
    expect(
      validateDelta(context({ session: session({ steps: easyRun(3750) }) }), scale(0.8)),
    ).toEqual({ ok: false, reason: "no_change" });
  });

  it("cuts a quality session's reps", () => {
    expect(
      validateDelta(
        context({ session: session({ type: "intervals", steps: intervals(5) }) }),
        scale(0.6),
      ),
    ).toMatchObject({
      ok: true,
      clamped: false,
      session: { type: "intervals", steps: intervals(3) },
    });
  });

  it("never grows a quality session: a rise clamps to 1 and changes nothing", () => {
    expect(
      validateDelta(
        context({ session: session({ type: "tempo", steps: intervals(5) }) }),
        scale(1.1),
      ),
    ).toEqual({ ok: false, reason: "no_change" });
  });

  it("shortens each rep when a cut rounds back to the same reps, instead of rejecting it", () => {
    const result = stepsOf(
      context({ session: session({ type: "intervals", steps: intervals(5) }) }),
      scale(0.9),
    );
    expect(result.session.steps[1]).toMatchObject({
      repeat: 5,
      steps: [{ kind: "work", distanceM: 900 }, { kind: "recovery" }],
    });
  });

  it("rejects a cut of a run already at the 20 min minimum as no_change", () => {
    // 3750 m is 20 min at the 320 s/km easy midpoint.
    expect(
      validateDelta(context({ session: session({ steps: easyRun(3750) }) }), scale(0.8)),
    ).toEqual({ ok: false, reason: "no_change" });
  });

  it("caps a rise at 110% of the longest run of 30 days: at the cap, and 1 m under it", () => {
    expect(validateDelta(context({ longestRecentM: 8000 }), scale(1.1))).toMatchObject({
      clamped: false,
      session: { steps: easyRun(8800) },
    });
    // 7999 x 1.1 floors to 8798, and the run to 8700.
    expect(validateDelta(context({ longestRecentM: 7999 }), scale(1.1))).toMatchObject({
      ok: true,
      delta: { kind: "scale", factor: 8798 / 8000 },
      clamped: true,
      session: { steps: easyRun(8700) },
    });
  });

  it("allows no rise without a run in 30 days, and still allows a cut", () => {
    expect(validateDelta(context({ longestRecentM: 0 }), scale(1.1))).toEqual({
      ok: false,
      reason: "no_change",
    });
    expect(validateDelta(context({ longestRecentM: 0 }), scale(0.8)).ok).toBe(true);
  });

  it("caps a long run's rise at 30% of the week at 4 days, skipped and missed runs left out", () => {
    const weekSessions = [
      other(7000),
      other(7000, "done", "tempo"),
      other(7000, "moved"),
      other(10_000, "skipped"),
      other(5000, "missed"),
    ];
    // L <= 0.3 x (21 000 + L): 9000 m, exactly 30% of 30 000.
    expect(validateDelta(context({ session: long(8500), weekSessions }), scale(1.1))).toMatchObject(
      {
        clamped: true,
        session: { steps: easyRun(9000) },
      },
    );
    // 8180 x 1.1 = 8998, under the cap: floored to 8900, not clamped.
    expect(validateDelta(context({ session: long(8180), weekSessions }), scale(1.1))).toMatchObject(
      {
        clamped: false,
        session: { steps: easyRun(8900) },
      },
    );
  });

  it("caps a long run's rise at 40% of the week at 3 days", () => {
    expect(
      validateDelta(
        context({ session: long(7500), weekSessions: [other(6000), other(6000)], daysPerWeek: 3 }),
        scale(1.1),
      ),
    ).toMatchObject({ clamped: true, session: { steps: easyRun(8000) } });
  });

  it("caps a long run's rise at 150 min at the easy midpoint, not an easy run's", () => {
    const ctx = { weekSessions: [other(100_000)], longestRecentM: 30_000 };
    expect(validateDelta(context({ ...ctx, session: long(27_000) }), scale(1.1))).toMatchObject({
      clamped: true,
      session: { steps: easyRun(28_100), target: { durationS: 8992 } },
    });
    expect(
      validateDelta(context({ ...ctx, session: session({ steps: easyRun(27_000) }) }), scale(1.1)),
    ).toMatchObject({ clamped: false, session: { steps: easyRun(29_700) } });
  });

  it("caps a rise at 10% over the previous week, counting the week's other sessions", () => {
    const ctx = { previousWeekM: 30_000, session: session({ steps: easyRun(7500) }) };
    expect(
      validateDelta(context({ ...ctx, weekSessions: [other(25_000)] }), scale(1.1)),
    ).toMatchObject({
      clamped: true,
      session: { steps: easyRun(8000) },
    });
    expect(
      validateDelta(
        context({
          ...ctx,
          session: session({ steps: easyRun(7272) }),
          weekSessions: [other(25_000)],
        }),
        scale(1.1),
      ),
    ).toMatchObject({ clamped: false, session: { steps: easyRun(7900) } });
  });

  it("sets no weekly cap in the plan's first week: no week before it", () => {
    expect(
      validateDelta(
        context({
          previousWeekM: null,
          session: session({ steps: easyRun(7500) }),
          weekSessions: [other(25_000)],
        }),
        scale(1.1),
      ),
    ).toMatchObject({ clamped: false, session: { steps: easyRun(8200) } });
  });

  it("illness or injury pauses: allows no rise after a week that ran nothing, and still a cut, easy and rest", () => {
    const ctx = { previousWeekM: 0 };
    expect(validateDelta(context(ctx), scale(1.1))).toEqual({ ok: false, reason: "no_change" });
    expect(validateDelta(context(ctx), scale(0.8))).toMatchObject({
      ok: true,
      clamped: false,
      session: { steps: easyRun(6400) },
    });
    expect(validateDelta(context(ctx), { kind: "rest" }).ok).toBe(true);
    expect(
      validateDelta(context({ ...ctx, session: session({ type: "tempo", steps: intervals(5) }) }), {
        kind: "easy",
      }).ok,
    ).toBe(true);
  });

  it.each([1.02, 1.1, 1.5])(
    "illness or injury pauses: a rise by %s of a session a re-entry eased clamps to 1 and changes nothing",
    (factor) => {
      expect(validateDelta(context({ eased: true }), scale(factor))).toEqual({
        ok: false,
        reason: "no_change",
      });
    },
  );

  it("illness or injury pauses: a session a re-entry eased still takes a cut, easy and rest", () => {
    expect(validateDelta(context({ eased: true }), scale(0.8))).toEqual({
      ok: true,
      delta: { kind: "scale", factor: 0.8 },
      clamped: false,
      session: {
        type: "easy",
        title: null,
        status: "planned",
        steps: easyRun(6400),
        target: { distanceM: 6400, durationS: 2048, zone: "easy" },
      },
    });
    expect(validateDelta(context({ eased: true }), { kind: "rest" })).toMatchObject({
      ok: true,
      session: { status: "skipped" },
    });
    expect(
      validateDelta(
        context({ eased: true, session: session({ type: "intervals", steps: intervals(5) }) }),
        { kind: "easy" },
      ),
    ).toMatchObject({ ok: true, session: { type: "easy", steps: easyRun(11_100) } });
  });

  it.each([1.02, 1.1, 1.5])(
    "illness or injury pauses: right after a paused week a rise by %s clamps to 1 and changes nothing",
    (factor) => {
      expect(validateDelta(context({ afterPause: true }), scale(factor))).toEqual({
        ok: false,
        reason: "no_change",
      });
      expect(
        validateDelta(context({ afterPause: true, session: long(8000) }), scale(factor)),
      ).toEqual({ ok: false, reason: "no_change" });
    },
  );

  it("illness or injury pauses: right after a paused week a cut by 0.8 applies, and so do easy and rest", () => {
    expect(validateDelta(context({ afterPause: true }), scale(0.8))).toEqual({
      ok: true,
      delta: { kind: "scale", factor: 0.8 },
      clamped: false,
      session: {
        type: "easy",
        title: null,
        status: "planned",
        steps: easyRun(6400),
        target: { distanceM: 6400, durationS: 2048, zone: "easy" },
      },
    });
    expect(validateDelta(context({ afterPause: true }), { kind: "rest" })).toMatchObject({
      ok: true,
      session: { status: "skipped" },
    });
    expect(
      validateDelta(
        context({ afterPause: true, session: session({ type: "tempo", steps: intervals(5) }) }),
        { kind: "easy" },
      ),
    ).toMatchObject({ ok: true, session: { type: "easy", steps: easyRun(11_100) } });
  });

  it("illness or injury pauses: right after a paused week a quality session's rise still changes nothing", () => {
    expect(
      validateDelta(
        context({ afterPause: true, session: session({ type: "tempo", steps: intervals(5) }) }),
        scale(1.1),
      ),
    ).toEqual({ ok: false, reason: "no_change" });
  });

  describe.each(["taper", "race"] as const)("in a %s-phase week", (phase) => {
    // Room for a rise in any other week: 10 000 m planned, 40 000 m of other runs, 20 000 m longest.
    const roomy = (type: "easy" | "long", ph: PlanPhase | null) =>
      context({
        phase: ph,
        session: session({ type, steps: easyRun(10_000) }),
        weekSessions: [other(40_000)],
      });

    it.each([
      ["easy", 1, 10_000],
      ["easy", 1.01, 10_100],
      ["easy", 1.1, 11_000],
      ["long", 1, 10_000],
      ["long", 1.01, 10_100],
      ["long", 1.1, 11_000],
    ] as const)(
      "a %s run's rise by %s clamps to 1 and changes nothing, where a base week grows it to %s m",
      (type, factor, baseM) => {
        expect(validateDelta(roomy(type, phase), scale(factor))).toEqual({
          ok: false,
          reason: "no_change",
        });
        const base = validateDelta(roomy(type, "base"), scale(factor));
        if (factor === 1) expect(base).toEqual({ ok: false, reason: "no_change" });
        else expect(base).toMatchObject({ ok: true, session: { steps: easyRun(baseM) } });
      },
    );

    it.each([
      ["easy", 0.5],
      ["easy", 0.9],
      ["long", 0.5],
      ["long", 0.9],
    ] as const)("a %s run's cut by %s applies as in any other week", (type, factor) => {
      const planned = session({ type });
      const result = validateDelta(context({ phase, session: planned }), scale(factor));
      expect(result).toEqual(validateDelta(context({ session: planned }), scale(factor)));
      expect(result).toMatchObject({
        ok: true,
        clamped: false,
        session: { steps: easyRun(8000 * factor) },
      });
    });

    it("a primer with strides cut by 0.9 becomes one plain easy run; a rise changes nothing", () => {
      // The race week's primer: 20 min easy and 4 strides, 3750 + 4 x 279 = 4866 m.
      const primer = session({ steps: withStrides(3750, 4) });
      expect(validateDelta(context({ phase, session: primer }), scale(0.9))).toMatchObject({
        ok: true,
        clamped: false,
        session: { type: "easy", steps: easyRun(4300) },
      });
      expect(validateDelta(context({ phase, session: primer }), scale(1.1))).toEqual({
        ok: false,
        reason: "no_change",
      });
    });

    it("easy and rest apply as in any other week", () => {
      expect(validateDelta(context({ phase }), { kind: "rest" })).toMatchObject({
        ok: true,
        session: { status: "skipped" },
      });
      expect(
        validateDelta(
          context({ phase, session: session({ type: "race_practice", steps: intervals(3) }) }),
          { kind: "easy" },
        ),
      ).toMatchObject({ ok: true, session: { type: "easy" } });
    });

    it("never changes the race", () => {
      expect(
        validateDelta(context({ phase, session: session({ type: "race" }) }), scale(0.9)),
      ).toEqual({ ok: false, reason: "race" });
    });
  });

  it.each([null, "base", "build", "peak"] as const)(
    "a rise by 1.1 in a %s phase grows the run as before",
    (phase) => {
      expect(validateDelta(context({ phase }), scale(1.1))).toMatchObject({
        ok: true,
        clamped: false,
        session: { steps: easyRun(8800) },
      });
      expect(
        validateDelta(
          context({ phase, session: long(8000), weekSessions: [other(30_000)] }),
          scale(1.1),
        ),
      ).toMatchObject({ ok: true, clamped: false, session: { steps: easyRun(8800) } });
    },
  );

  it("grows only the easy run of a long run with a finish, inside the caps on the whole session", () => {
    // 110% of the 16 000 m recent longest is 17 600 m: the rise stops at 1.1, all of it on the easy run.
    expect(
      validateDelta(
        context({
          session: session({ type: "long", steps: withFinish(12_000, 4000) }),
          weekSessions: [other(60_000)],
          longestRecentM: 16_000,
        }),
        scale(1.5),
      ),
    ).toMatchObject({
      ok: true,
      delta: scale(1.1),
      clamped: true,
      session: { type: "long", steps: withFinish(13_200, 4000) },
    });
  });

  it("never clamps a rise below the planned run: a week already over 10% leaves it as planned", () => {
    expect(
      validateDelta(
        context({
          previousWeekM: 30_000,
          weekSessions: [other(26_000)],
          session: session({ steps: easyRun(7500) }),
        }),
        scale(1.1),
      ),
    ).toEqual({ ok: false, reason: "no_change" });
  });

  it("never divides by an empty session: a rise of a session with no steps changes nothing", () => {
    expect(
      validateDelta(context({ session: session({ type: "strength", steps: [] }) }), scale(1.1)),
    ).toEqual({ ok: false, reason: "no_change" });
  });

  // --- properties over generated sessions, weeks and deltas -----------------------------------------

  const typeArb = fc.constantFrom<SessionType>(
    "easy",
    "long",
    "intervals",
    "tempo",
    "race_practice",
    "race",
  );
  /** An easy or long run's steps: plain, with 6 strides, or with a marathon-pace finish of a fifth. */
  const runSteps = (distanceM: number, extras: "plain" | "strides" | "finish"): SessionSteps =>
    extras === "strides"
      ? withStrides(distanceM, 6)
      : extras === "finish"
        ? withFinish(distanceM, Math.max(1000, Math.round(distanceM / 5)))
        : easyRun(distanceM);
  const sessionArb: fc.Arbitrary<DeltaSession> = fc
    .record({
      type: typeArb,
      distanceM: fc.integer({ min: 1000, max: 40_000 }),
      extras: fc.constantFrom("plain" as const, "strides" as const, "finish" as const),
      reps: fc.integer({ min: 2, max: 12 }),
      status: fc.constantFrom(...sessionStatusSchema.options),
      source: fc.constantFrom("plan" as const, "custom" as const),
      dayOffset: fc.integer({ min: -3, max: 6 }),
    })
    .map((s) => {
      const steps: SessionSteps = QUALITY.has(s.type)
        ? intervals(s.reps)
        : s.type === "race"
          ? [{ kind: "run", zone: "race", distanceM: s.distanceM, durationS: null }]
          : runSteps(s.distanceM, s.extras);
      return session({
        type: s.type,
        status: s.status,
        source: s.source,
        date: addDays(TODAY, s.dayOffset),
        steps,
      });
    });
  const contextArb: fc.Arbitrary<DeltaContext> = fc
    .record({
      session: sessionArb,
      phase: fc.constantFrom<PlanPhase | null>(null, ...planPhaseSchema.options),
      week: fc.array(
        fc.record({
          distanceM: fc.integer({ min: 1000, max: 30_000 }),
          status: fc.constantFrom(...sessionStatusSchema.options),
        }),
        { maxLength: 6 },
      ),
      previousWeekM: fc.oneof(
        fc.constant(null),
        fc.constant(0),
        fc.integer({ min: 1, max: 100_000 }),
      ),
      longestRecentM: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 40_000 })),
      daysPerWeek: fc.integer({ min: 3, max: 7 }),
      paused: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
      coachAdjusted: fc.boolean(),
      eased: fc.boolean(),
      afterPause: fc.boolean(),
    })
    .map((c) =>
      context({
        session: c.session,
        phase: c.phase,
        weekSessions: c.week.map((w) => other(w.distanceM, w.status)),
        previousWeekM: c.previousWeekM,
        longestRecentM: c.longestRecentM,
        daysPerWeek: c.daysPerWeek,
        paused: c.paused,
        coachAdjusted: c.coachAdjusted,
        eased: c.eased,
        afterPause: c.afterPause,
      }),
    );
  const deltaArb: fc.Arbitrary<PlanDelta> = fc.oneof(
    fc.double({ min: -1, max: 3, noNaN: true }).map(scale),
    fc.constant({ kind: "easy" as const }),
    fc.constant({ kind: "rest" as const }),
  );
  /** Where a rise lands unless a cap stops it: an open easy or long plan run, nothing eased or paused. */
  const openContextArb: fc.Arbitrary<DeltaContext> = fc
    .record({
      ctx: contextArb,
      type: fc.constantFrom<SessionType>("easy", "long"),
      distanceM: fc.integer({ min: 2000, max: 30_000 }),
      extras: fc.constantFrom("plain" as const, "strides" as const, "finish" as const),
      othersM: fc.integer({ min: 20_000, max: 80_000 }),
    })
    .map(({ ctx, type, distanceM, extras, othersM }) => ({
      ...ctx,
      session: session({ type, steps: runSteps(distanceM, extras) }),
      weekSessions: [other(othersM)],
      previousWeekM: null,
      longestRecentM: Math.max(ctx.longestRecentM, distanceM),
      paused: false,
      coachAdjusted: false,
      eased: false,
      afterPause: false,
    }));
  const anyContextArb = fc.oneof(contextArb, openContextArb);
  /** Mostly rises, so the caps on them are reached. */
  const riseArb: fc.Arbitrary<PlanDelta> = fc.oneof(
    { weight: 3, arbitrary: fc.double({ min: 1, max: 1.5, noNaN: true }).map(scale) },
    { weight: 1, arbitrary: deltaArb },
  );

  it("is deterministic and returns steps the contract accepts", () => {
    fc.assert(
      fc.property(anyContextArb, deltaArb, (ctx, delta) => {
        const result = validateDelta(ctx, delta);
        expect(validateDelta(ctx, delta)).toEqual(result);
        if (result.ok)
          expect(sessionStepsSchema.parse(result.session.steps)).toEqual(result.session.steps);
      }),
    );
  });

  it("never changes a race, a custom workout, a past or a locked session", () => {
    fc.assert(
      fc.property(contextArb, deltaArb, (ctx, delta) => {
        const s = ctx.session!;
        const untouchable =
          s.type === "race" ||
          s.source === "custom" ||
          daysBetween(ctx.today, s.date) < 0 ||
          (s.status !== "planned" && s.status !== "moved");
        if (untouchable) expect(validateDelta(ctx, delta).ok).toBe(false);
      }),
    );
  });

  it("never raises a taper or race-week session: an accepted or clamped delta only keeps or cuts it", () => {
    fc.assert(
      fc.property(
        anyContextArb,
        fc.constantFrom("taper" as const, "race" as const),
        riseArb,
        (drawn, phase, delta) => {
          const ctx = { ...drawn, phase };
          const before = ctx.session!.target;
          const result = validateDelta(ctx, delta);
          if (result.ok) {
            expect(result.session.target.distanceM).toBeLessThanOrEqual(before.distanceM);
            if (result.delta.kind === "scale") expect(result.delta.factor).toBeLessThanOrEqual(1);
          }
          // A rise the same session would take in a base week changes nothing here.
          const base = validateDelta({ ...ctx, phase: "base" }, delta);
          if (base.ok && base.session.target.distanceM > before.distanceM) {
            expect(result).toEqual({ ok: false, reason: "no_change" });
          }
        },
      ),
    );
  });

  it("never leaves strides or a finish after a cut, and never grows them on a rise", () => {
    fc.assert(
      fc.property(anyContextArb, riseArb, (ctx, delta) => {
        const s = ctx.session!;
        const result = validateDelta(ctx, delta);
        if (!result.ok || result.delta.kind !== "scale" || QUALITY.has(s.type)) return;
        if (s.steps.length < 2) return;
        if (result.delta.factor < 1) {
          expect(result.session.steps).toHaveLength(1);
          expect(result.session.steps[0]).toMatchObject({
            kind: "run",
            zone: "easy",
            durationS: null,
          });
        } else {
          expect(result.session.steps.slice(1)).toEqual(s.steps.slice(1));
        }
      }),
    );
  });

  it("never lets an accepted rise break 110% of the recent longest, the long-run share, 150 min or +10% on last week, nor grow an eased session, one right after a paused week, one after a week that ran nothing or one in a taper or race week", () => {
    fc.assert(
      fc.property(anyContextArb, riseArb, (ctx, delta) => {
        const result = validateDelta(ctx, delta);
        const before = ctx.session!.target.distanceM;
        if (!result.ok || result.session.target.distanceM <= before) return;
        const newM = result.session.target.distanceM;
        const othersM = ctx.weekSessions
          .filter((w) => w.status !== "skipped" && w.status !== "missed")
          .reduce((sum, w) => sum + w.target.distanceM, 0);
        expect(delta.kind).toBe("scale");
        expect(ctx.eased).toBe(false);
        expect(ctx.afterPause).toBe(false);
        expect(ctx.phase === "taper" || ctx.phase === "race").toBe(false);
        expect(ctx.previousWeekM).not.toBe(0);
        expect(ctx.longestRecentM).toBeGreaterThan(0);
        expect(newM).toBeLessThanOrEqual(Math.floor(ctx.longestRecentM * 1.1));
        if (ctx.session!.type === "long") {
          const share = ctx.daysPerWeek >= 4 ? 0.3 : 0.4;
          expect(newM).toBeLessThanOrEqual(share * (othersM + newM) + 1e-6);
          expect(result.session.target.durationS).toBeLessThanOrEqual(9000);
        }
        if (ctx.previousWeekM !== null) {
          expect(othersM + newM).toBeLessThanOrEqual(Math.floor(ctx.previousWeekM * 1.1));
        }
      }),
    );
  });
});
