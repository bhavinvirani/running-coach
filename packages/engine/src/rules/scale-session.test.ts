import {
  paceZoneSchema,
  REPEAT_MAX,
  REPEAT_STEPS_MAX,
  sessionStepsSchema,
  STEP_MAX_DISTANCE_M,
  STEP_MAX_DURATION_S,
  stepKindSchema,
  type PlanPaces,
  type SessionSteps,
  type Step,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scaleSession, scaleSteps } from "./scale-session";
import { flattenSteps, sessionTarget } from "./session-target";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // midpoint 320 s/km: 20 min is 3750 m
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 },
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 223 },
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};

const byTime = (kind: Step["kind"], zone: Step["zone"], durationS: number): Step => ({
  kind,
  zone,
  distanceM: null,
  durationS,
});
const byDistance = (kind: Step["kind"], zone: Step["zone"], distanceM: number): Step => ({
  kind,
  zone,
  distanceM,
  durationS: null,
});
const easyRun = (distanceM: number): SessionSteps => [byDistance("run", "easy", distanceM)];
const warmup = byTime("warmup", "easy", 900);
const cooldown = byTime("cooldown", "easy", 600);
const intervals = (reps: number): SessionSteps => [
  warmup,
  {
    repeat: reps,
    steps: [byDistance("work", "interval", 1000), byTime("recovery", "easy", 180)],
  },
  cooldown,
];
const tempo = (work: Step): SessionSteps => [warmup, work, cooldown];
// Strides as the plan writes them: 20 s at repetition pace (91 m at 219.5 s/km) and a 60 s jog
// (188 m at 320 s/km), 279 m and 80 s a round.
const strides = (repeat: number) => ({
  repeat,
  steps: [byTime("run", "repetition", 20), byTime("recovery", "easy", 60)],
});
const withStrides = (runM: number, repeat: number): SessionSteps => [
  byDistance("run", "easy", runM),
  strides(repeat),
];
const withFinish = (easyM: number, finishM: number): SessionSteps => [
  byDistance("run", "easy", easyM),
  byDistance("run", "marathon", finishM),
];

const scale = (steps: SessionSteps, factor: number) =>
  scaleSession({ steps, factor, paces: PACES });

describe("scale session", () => {
  it("cuts an easy run by the factor, floored to whole 100 m", () => {
    expect(scale(easyRun(8000), 0.75)).toEqual({ steps: easyRun(6000), atMinimum: false });
    expect(scale(easyRun(8123), 0.9)).toEqual({ steps: easyRun(7300), atMinimum: false });
  });

  it("never cuts an easy run below the 20 min minimum, 3750 m at a 320 s/km midpoint", () => {
    expect(scale(easyRun(5000), 0.5)).toEqual({ steps: easyRun(3750), atMinimum: true });
  });

  it("stops at the minimum 1 m under its 100 m step, and not 1 m over it", () => {
    // 7599 x 0.5 floors to 3700, under 3750; 7600 x 0.5 is 3800.
    expect(scale(easyRun(7599), 0.5)).toEqual({ steps: easyRun(3750), atMinimum: true });
    expect(scale(easyRun(7600), 0.5)).toEqual({ steps: easyRun(3800), atMinimum: false });
  });

  it("keeps a run already under 20 min as it is when cut", () => {
    expect(scale(easyRun(3000), 0.5)).toEqual({ steps: easyRun(3000), atMinimum: true });
  });

  it("cuts a run by time to whole 10 s, never under 1200 s", () => {
    expect(scale([byTime("run", "easy", 3600)], 0.75).steps).toEqual([byTime("run", "easy", 2700)]);
    expect(scale([byTime("run", "easy", 2405)], 0.5)).toEqual({
      steps: [byTime("run", "easy", 1200)],
      atMinimum: false,
    });
    expect(scale([byTime("run", "easy", 1234)], 0.9)).toEqual({
      steps: [byTime("run", "easy", 1200)],
      atMinimum: true,
    });
  });

  it("grows an easy run by the factor, floored to 100 m but never under the original", () => {
    expect(scale(easyRun(8000), 1.1).steps).toEqual(easyRun(8800));
    expect(scale(easyRun(8050), 1.01).steps).toEqual(easyRun(8100));
    expect(scale(easyRun(8050), 1.005).steps).toEqual(easyRun(8050));
    expect(scale([byTime("run", "easy", 3600)], 1.1).steps).toEqual([byTime("run", "easy", 3960)]);
  });

  it("caps a grown step at the longest step the contract allows", () => {
    expect(scale(easyRun(95_000), 1.1).steps).toEqual(easyRun(STEP_MAX_DISTANCE_M));
  });

  it("leaves the steps as they are at factor 1, even off the 100 m grid", () => {
    expect(scale(easyRun(8123), 1)).toEqual({ steps: easyRun(8123), atMinimum: false });
  });

  it("scales only an easy session's run steps outside repeats: a walk-run stays as it is", () => {
    const walkRun: SessionSteps = [
      { repeat: 6, steps: [byTime("run", "easy", 240), byTime("recovery", "easy", 60)] },
    ];
    expect(scale(walkRun, 0.5).steps).toEqual(walkRun);
    expect(scale([warmup, byDistance("run", "easy", 8000)], 0.5).steps).toEqual([
      warmup,
      byDistance("run", "easy", 4000),
    ]);
  });

  it("cuts a quality session's reps by the factor, rounding half up; warmup and cooldown stay", () => {
    expect(scale(intervals(5), 0.6)).toEqual({ steps: intervals(3), atMinimum: false });
    expect(scale(intervals(5), 0.5).steps).toEqual(intervals(3));
  });

  it("shortens each rep's work instead when the factor leaves the rep count as it is", () => {
    const reps = (count: number, workM: number): SessionSteps => [
      warmup,
      {
        repeat: count,
        steps: [byDistance("work", "threshold", workM), byTime("recovery", "easy", 60)],
      },
      cooldown,
    ];
    // 2 x 1500 m at 0.8: round(1.6) is still 2 reps, so each rep runs 1200 m.
    expect(scale(reps(2, 1500), 0.8).steps).toEqual(reps(2, 1200));
    expect(scale(intervals(5), 0.9).steps).toEqual([
      warmup,
      { repeat: 5, steps: [byDistance("work", "interval", 900), byTime("recovery", "easy", 180)] },
      cooldown,
    ]);
  });

  it("unwraps a repeat cut to one rep into its steps once", () => {
    const [w, repeat, c] = intervals(2) as [Step, { steps: Step[] }, Step];
    expect(scale(intervals(2), 0.5).steps).toEqual([w, ...repeat.steps, c]);
    expect(scale(intervals(5), 0.05).steps).toEqual([w, ...repeat.steps, c]);
  });

  it("keeps a repeat with no work step, and run steps, of a quality session as they are", () => {
    const strides = {
      repeat: 4,
      steps: [byTime("run", "easy", 20), byTime("recovery", "easy", 60)],
    };
    const steps: SessionSteps = [warmup, strides, byDistance("work", "threshold", 3000), cooldown];
    expect(scale(steps, 0.5).steps).toEqual([
      warmup,
      strides,
      byDistance("work", "threshold", 1500),
      cooldown,
    ]);
  });

  it("cuts a work step outside a repeat to whole 100 m or 10 s", () => {
    expect(scale(tempo(byDistance("work", "threshold", 3000)), 0.75).steps).toEqual(
      tempo(byDistance("work", "threshold", 2200)),
    );
    expect(scale(tempo(byTime("work", "threshold", 1200)), 0.75).steps).toEqual(
      tempo(byTime("work", "threshold", 900)),
    );
  });

  it("keeps a cut work step positive: one 100 m or 10 s step, or the step itself when shorter", () => {
    expect(scale(tempo(byDistance("work", "repetition", 150)), 0.5).steps).toEqual(
      tempo(byDistance("work", "repetition", 100)),
    );
    expect(scale(tempo(byTime("work", "threshold", 1200)), 0.004).steps).toEqual(
      tempo(byTime("work", "threshold", 10)),
    );
    expect(scale(tempo(byDistance("work", "repetition", 60)), 0.5).steps).toEqual(
      tempo(byDistance("work", "repetition", 60)),
    );
  });

  it("never grows a quality session: the caller clamps, and a factor over 1 leaves it as it is", () => {
    expect(scale(intervals(5), 1.1).steps).toEqual(intervals(5));
    expect(scale(tempo(byDistance("work", "threshold", 3000)), 1.1).steps).toEqual(
      tempo(byDistance("work", "threshold", 3000)),
    );
  });

  it("strides are run steps, not work: an easy run with strides is no quality session and grows", () => {
    expect(scale(withStrides(6000, 6), 1.1)).toEqual({
      steps: withStrides(6600, 6),
      atMinimum: false,
    });
  });

  it("cuts an easy run with strides as one easy run of its whole distance: the strides go", () => {
    // 6000 + 6 x 279 = 7674 m, x 0.8 = 6139, floored to 6100.
    expect(scale(withStrides(6000, 6), 0.8)).toEqual({ steps: easyRun(6100), atMinimum: false });
  });

  it("cuts a long run with a marathon-pace finish as one easy run of its whole distance", () => {
    expect(scale(withFinish(16_000, 4000), 0.75)).toEqual({
      steps: easyRun(15_000),
      atMinimum: false,
    });
  });

  it("merges the extras on the smallest cut too: 0.99 of 4866 m floors to 4800", () => {
    // The 20 min primer with 4 strides: 3750 + 4 x 279 m.
    expect(scale(withStrides(3750, 4), 0.99)).toEqual({ steps: easyRun(4800), atMinimum: false });
  });

  it("floors a cut session with extras at 20 min for the whole session, not per step", () => {
    // 4000 + 1000 m at 0.76 is 3800 m; at 0.75 it floors to 3700, under the 3750 m floor.
    expect(scale(withFinish(4000, 1000), 0.76)).toEqual({ steps: easyRun(3800), atMinimum: false });
    expect(scale(withFinish(4000, 1000), 0.75)).toEqual({ steps: easyRun(3750), atMinimum: true });
    // Per step, the 3750 m run and the 1000 m finish would each have stayed as they were.
    expect(scale(withFinish(3750, 1000), 0.5)).toEqual({ steps: easyRun(3750), atMinimum: true });
  });

  it("keeps a cut session with extras already under 20 min at its own distance", () => {
    // 2000 + 2 x 279 = 2558 m.
    expect(scale(withStrides(2000, 2), 0.5)).toEqual({ steps: easyRun(2558), atMinimum: true });
  });

  it("never merges a session with extras past the longest step the contract allows", () => {
    expect(scale(withFinish(99_000, 5000), 0.99)).toEqual({
      steps: easyRun(99_000),
      atMinimum: false,
    });
  });

  it("grows only the first easy run of a session with extras: strides and finish stay as planned", () => {
    expect(scale(withFinish(16_000, 4000), 1.1).steps).toEqual(withFinish(17_600, 4000));
    expect(scale([byTime("run", "easy", 3600), strides(6)], 1.1).steps).toEqual([
      byTime("run", "easy", 3960),
      strides(6),
    ]);
  });

  it("finds extras only after an easy run step that comes first: other sessions scale as before", () => {
    // A repeat first: its run stays and the run after it is cut on its own.
    expect(scale([strides(4), byDistance("run", "easy", 8000)], 0.5).steps).toEqual([
      strides(4),
      byDistance("run", "easy", 4000),
    ]);
    // A marathon-pace run first: each run step is cut on its own, each at its 20 min floor.
    expect(scale(withFinish(3000, 8000).reverse(), 0.5).steps).toEqual([
      byDistance("run", "marathon", 4000),
      byDistance("run", "easy", 3000),
    ]);
  });

  it("returns the scaled steps alone from scaleSteps", () => {
    expect(scaleSteps({ steps: easyRun(8000), factor: 0.75, paces: PACES })).toEqual(easyRun(6000));
  });

  it.each([0, -0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects factor %s as a programmer error (the caller clamps)",
    (factor) => {
      expect(() => scale(easyRun(8000), factor)).toThrow(RangeError);
    },
  );

  // --- properties over generated sessions ---------------------------------------------------------

  const stepArb: fc.Arbitrary<Step> = fc
    .record({
      kind: fc.constantFrom(...stepKindSchema.options),
      zone: fc.constantFrom(...paceZoneSchema.options),
      byDistance: fc.boolean(),
      distanceM: fc.integer({ min: 1, max: STEP_MAX_DISTANCE_M }),
      durationS: fc.integer({ min: 1, max: STEP_MAX_DURATION_S }),
    })
    .map((s) => ({
      kind: s.kind,
      zone: s.zone,
      distanceM: s.byDistance ? s.distanceM : null,
      durationS: s.byDistance ? null : s.durationS,
    }));
  const stepsArb: fc.Arbitrary<SessionSteps> = fc.array(
    fc.oneof(
      stepArb,
      fc.record({
        repeat: fc.integer({ min: 2, max: REPEAT_MAX }),
        steps: fc.array(stepArb, { minLength: 1, maxLength: REPEAT_STEPS_MAX }),
      }),
    ),
    { maxLength: 6 },
  );
  const factorArb = fc.double({ min: 0.01, max: 1.5, noNaN: true });
  const isQuality = (steps: SessionSteps) =>
    flattenSteps(steps).some(({ step }) => step.kind === "work");
  /** An easy or long run with extras: no work, an easy run step first and anything after it. */
  const hasExtras = (steps: SessionSteps) => {
    const first = steps[0];
    return (
      !isQuality(steps) &&
      steps.length > 1 &&
      first !== undefined &&
      !("repeat" in first) &&
      first.kind === "run" &&
      first.zone === "easy"
    );
  };
  /** Easy and long runs with strides or a marathon-pace finish, as the plan writes them. */
  const extrasArb: fc.Arbitrary<SessionSteps> = fc
    .record({
      first: fc.oneof(
        fc.integer({ min: 1, max: 60_000 }).map((m) => byDistance("run", "easy", m)),
        fc.integer({ min: 1, max: 4 * 3600 }).map((s) => byTime("run", "easy", s)),
      ),
      finish: fc.boolean(),
      repeat: fc.integer({ min: 2, max: 10 }),
      finishM: fc.integer({ min: 1000, max: 5000 }),
    })
    .map(({ first, finish, repeat, finishM }) => [
      first,
      finish ? byDistance("run", "marathon", finishM) : strides(repeat),
    ]);
  const anyStepsArb = fc.oneof(stepsArb, extrasArb);

  it("always returns steps the contract accepts, the same for the same input", () => {
    fc.assert(
      fc.property(anyStepsArb, factorArb, (steps, factor) => {
        const result = scaleSteps({ steps, factor, paces: PACES });
        expect(sessionStepsSchema.parse(result)).toEqual(result);
        expect(scaleSteps({ steps, factor, paces: PACES })).toEqual(result);
      }),
    );
  });

  it("never lengthens a session cut below 1 or shortens one grown above it", () => {
    fc.assert(
      fc.property(anyStepsArb, factorArb, (steps, factor) => {
        const before = sessionTarget(steps, PACES);
        const after = sessionTarget(scaleSteps({ steps, factor, paces: PACES }), PACES);
        if (factor < 1) {
          expect(after.distanceM).toBeLessThanOrEqual(before.distanceM);
          // A cut runs the extras at easy pace: at most the time of the whole distance run easy.
          const plain = Math.min(before.distanceM, STEP_MAX_DISTANCE_M);
          expect(after.durationS).toBeLessThanOrEqual(
            hasExtras(steps) ? sessionTarget(easyRun(plain), PACES).durationS : before.durationS,
          );
        } else if (isQuality(steps)) {
          expect(after).toEqual(before);
        } else {
          expect(after.distanceM).toBeGreaterThanOrEqual(before.distanceM);
        }
      }),
    );
  });

  it("never leaves extras after a cut: one easy run, at most the session's meters, at least 20 min or all of it", () => {
    fc.assert(
      fc.property(
        anyStepsArb,
        fc.double({ min: 0.01, max: 1, maxExcluded: true, noNaN: true }),
        (steps, factor) => {
          fc.pre(hasExtras(steps));
          const beforeM = Math.min(sessionTarget(steps, PACES).distanceM, STEP_MAX_DISTANCE_M);
          const after = scaleSteps({ steps, factor, paces: PACES });
          expect(after).toHaveLength(1);
          const [run] = after as [Step];
          expect(run).toMatchObject({ kind: "run", zone: "easy", durationS: null });
          expect(run.distanceM).toBeLessThanOrEqual(beforeM);
          expect(run.distanceM).toBeGreaterThanOrEqual(Math.min(beforeM, 3750));
        },
      ),
    );
  });

  it("never grows the extras on a rise: only the first easy run grows", () => {
    fc.assert(
      fc.property(
        anyStepsArb,
        fc.double({ min: 1, max: 1.5, minExcluded: true, noNaN: true }),
        (steps, factor) => {
          fc.pre(hasExtras(steps));
          const after = scaleSteps({ steps, factor, paces: PACES });
          expect(after.slice(1)).toEqual(steps.slice(1));
          expect(sessionTarget(after.slice(0, 1), PACES).distanceM).toBeGreaterThanOrEqual(
            sessionTarget(steps.slice(0, 1), PACES).distanceM,
          );
        },
      ),
    );
  });

  it("never takes an easy run under 20 min, or under its own length when shorter", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60_000 }), factorArb, (distanceM, factor) => {
        const [step] = scaleSteps({ steps: easyRun(distanceM), factor, paces: PACES }) as [Step];
        expect(step.distanceM).toBeGreaterThanOrEqual(Math.min(distanceM, 3750));
        if (factor < 1) expect(step.distanceM).toBeLessThanOrEqual(distanceM);
        else
          expect(step.distanceM).toBeLessThanOrEqual(
            Math.max(distanceM, distanceM * factor) + 1e-6,
          );
      }),
    );
  });
});
