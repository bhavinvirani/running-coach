import {
  GARMIN_WORKOUT_NAME_MAX,
  GARMIN_WORKOUT_STEPS_MAX,
  garminStepCount,
  garminWorkoutSchema,
  paceZoneSchema,
  REPEAT_MAX,
  REPEAT_STEPS_MAX,
  SESSION_TYPE_NAMES,
  stepKindSchema,
  STEP_MAX_DISTANCE_M,
  STEP_MAX_DURATION_S,
  type GarminWorkout,
  type GarminWorkoutStep,
  type PlanPaces,
  type SessionSteps,
  type Step,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generatePlan } from "../plan/generate";
import { planInputArb } from "../plan/plan-arbitraries";
import { garminWorkout } from "./garmin-workout";
import { sessionTarget } from "./session-target";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // midpoint 320 s/km
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 }, // midpoint 255 s/km
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 223 },
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};

// The oracle, written out here rather than read from the rule's constant.
const TARGETED = new Set<Step["kind"]>(["run", "work"]);

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

const THRESHOLD_SESSION: SessionSteps = [
  byTime("warmup", "easy", 900),
  {
    repeat: 2,
    steps: [byDistance("work", "threshold", 3000), byTime("recovery", "easy", 60)],
  },
  byTime("cooldown", "easy", 600),
];

/** Every source step beside the Garmin step it became, repeats opened, with each repeat's count. */
function pairs(steps: SessionSteps, workout: GarminWorkout) {
  expect(workout.steps).toHaveLength(steps.length);
  return steps.flatMap((item, k) => {
    const out = workout.steps[k]!;
    if ("repeat" in item) {
      expect("repeat" in out && out.repeat).toBe(item.repeat);
      const inner = "repeat" in out ? out.steps : [];
      expect(inner).toHaveLength(item.steps.length);
      return item.steps.map((step, j) => ({ step, out: inner[j]! }));
    }
    expect("repeat" in out).toBe(false);
    return [{ step: item, out: out as GarminWorkoutStep }];
  });
}

/** The structure, the ends, the targets and the estimate, for any steps and paces. */
function assertWorkoutKeepsTheSession(steps: SessionSteps, paces: PlanPaces, name: string) {
  const workout = garminWorkout({ name, steps, paces });
  expect(garminWorkoutSchema.safeParse(workout).success).toBe(true);
  expect(workout.name).toBe(name);
  expect(workout.estimatedDurationS).toBe(sessionTarget(steps, paces).durationS);
  for (const { step, out } of pairs(steps, workout)) {
    expect(out.distanceM).toBe(step.distanceM);
    expect(out.durationS).toBe(step.durationS);
    if (TARGETED.has(step.kind)) expect(out.pace).toEqual(paces[step.zone]);
    else expect(out.pace).toBeNull();
  }
}

// --- arbitraries for workouts a runner builds -----------------------------------------------------

const stepArb: fc.Arbitrary<Step> = fc
  .record({
    kind: fc.constantFrom(...stepKindSchema.options),
    zone: fc.constantFrom(...paceZoneSchema.options),
    byDistance: fc.boolean(),
    distanceM: fc.integer({ min: 1, max: STEP_MAX_DISTANCE_M }),
    durationS: fc.integer({ min: 1, max: STEP_MAX_DURATION_S }),
  })
  .map((drawn) => ({
    kind: drawn.kind,
    zone: drawn.zone,
    distanceM: drawn.byDistance ? drawn.distanceM : null,
    durationS: drawn.byDistance ? null : drawn.durationS,
  }));
const stepsArb: fc.Arbitrary<SessionSteps> = fc.array(
  fc.oneof(
    stepArb,
    fc.record({
      repeat: fc.integer({ min: 2, max: REPEAT_MAX }),
      steps: fc.array(stepArb, { minLength: 1, maxLength: REPEAT_STEPS_MAX }),
    }),
  ),
  { minLength: 1, maxLength: 8 },
);
// Any band the contract allows: whole seconds, fast end first, 2:30 to 15:00 per km.
const bandArb = fc
  .tuple(fc.integer({ min: 150, max: 900 }), fc.integer({ min: 0, max: 120 }))
  .map(([fastSPerKm, width]) => ({ fastSPerKm, slowSPerKm: fastSPerKm + width }));
const pacesArb: fc.Arbitrary<PlanPaces> = fc.record({
  easy: bandArb,
  marathon: bandArb,
  threshold: bandArb,
  interval: bandArb,
  repetition: bandArb,
  race: bandArb,
});
const nameArb = fc.string({ minLength: 1, maxLength: GARMIN_WORKOUT_NAME_MAX });

// Each run builds a plan of up to 52 weeks; CI's runner needs more than vitest's 5 s.
const PROPERTY_TIMEOUT_MS = 120_000;

describe("garmin workout", () => {
  it("maps warm-up, run, work, recovery and cool-down to Garmin's warmup, interval, interval, recovery and cooldown", () => {
    const workout = garminWorkout({
      name: "Every kind",
      steps: [
        byTime("warmup", "easy", 600),
        byDistance("run", "easy", 2000),
        byDistance("work", "interval", 800),
        byTime("recovery", "easy", 120),
        byTime("cooldown", "easy", 300),
      ],
      paces: PACES,
    });
    expect(workout.steps.map((step) => ("type" in step ? step.type : "repeat"))).toEqual([
      "warmup",
      "interval",
      "interval",
      "recovery",
      "cooldown",
    ]);
  });

  it("targets a threshold repeat with its band and leaves warm-up, recovery and cool-down open", () => {
    expect(garminWorkout({ name: "Tempo", steps: THRESHOLD_SESSION, paces: PACES })).toEqual({
      name: "Tempo",
      // 900 + 2 x (765 + 60) + 600: the 3000 m at the threshold midpoint of 255 s/km is 765 s.
      estimatedDurationS: 3150,
      steps: [
        { type: "warmup", distanceM: null, durationS: 900, pace: null },
        {
          repeat: 2,
          steps: [
            {
              type: "interval",
              distanceM: 3000,
              durationS: null,
              pace: { fastSPerKm: 251, slowSPerKm: 259 },
            },
            { type: "recovery", distanceM: null, durationS: 60, pace: null },
          ],
        },
        { type: "cooldown", distanceM: null, durationS: 600, pace: null },
      ],
    } satisfies GarminWorkout);
  });

  it("targets an easy run by distance with the easy band", () => {
    expect(
      garminWorkout({ name: "Easy", steps: [byDistance("run", "easy", 8000)], paces: PACES }),
    ).toEqual({
      name: "Easy",
      estimatedDurationS: 2560,
      steps: [
        {
          type: "interval",
          distanceM: 8000,
          durationS: null,
          pace: { fastSPerKm: 300, slowSPerKm: 340 },
        },
      ],
    });
  });

  it("leaves a warm-up, recovery or cool-down open even at a hard zone", () => {
    const workout = garminWorkout({
      name: "Open",
      steps: [
        byTime("warmup", "threshold", 600),
        byTime("recovery", "interval", 60),
        byTime("cooldown", "race", 300),
      ],
      paces: PACES,
    });
    expect(workout.steps.map((step) => ("pace" in step ? step.pace : "repeat"))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("keeps a repeat's count and every step inside it, a warm-up inside one too", () => {
    const workout = garminWorkout({
      name: "Ladder",
      steps: [
        {
          repeat: 5,
          steps: [
            byTime("warmup", "easy", 60),
            byDistance("work", "repetition", 200),
            byDistance("run", "marathon", 400),
          ],
        },
      ],
      paces: PACES,
    });
    expect(workout.steps).toEqual([
      {
        repeat: 5,
        steps: [
          { type: "warmup", distanceM: null, durationS: 60, pace: null },
          { type: "interval", distanceM: 200, durationS: null, pace: PACES.repetition },
          { type: "interval", distanceM: 400, durationS: null, pace: PACES.marathon },
        ],
      },
    ]);
  });

  it("accepts a name of 1 character and of exactly the 60-character cap", () => {
    expect(garminWorkout({ name: "E", steps: THRESHOLD_SESSION, paces: PACES }).name).toBe("E");
    const longest = "x".repeat(GARMIN_WORKOUT_NAME_MAX);
    expect(garminWorkout({ name: longest, steps: THRESHOLD_SESSION, paces: PACES }).name).toBe(
      longest,
    );
  });

  it("rejects an empty name and one over the 60-character cap as a programmer error", () => {
    expect(() => garminWorkout({ name: "", steps: THRESHOLD_SESSION, paces: PACES })).toThrow(
      RangeError,
    );
    expect(() =>
      garminWorkout({
        name: "x".repeat(GARMIN_WORKOUT_NAME_MAX + 1),
        steps: THRESHOLD_SESSION,
        paces: PACES,
      }),
    ).toThrow(RangeError);
  });

  it("rejects a session with no steps as a programmer error: the API pushes only sessions with steps", () => {
    expect(() => garminWorkout({ name: "Empty", steps: [], paces: PACES })).toThrow(RangeError);
  });

  it(
    "keeps every generated plan session's structure, ends, targets and time on the watch",
    () => {
      fc.assert(
        fc.property(planInputArb, (of) => {
          const result = generatePlan(of);
          fc.pre(result.ok);
          if (!result.ok) return;
          const { paces, weeks } = result.plan;
          for (const session of weeks.flatMap((week) => week.sessions)) {
            if (session.steps.length === 0) continue;
            // Garmin holds at most 50 steps; the generator stays under it, so every session can go.
            expect(garminStepCount(session.steps)).toBeLessThanOrEqual(GARMIN_WORKOUT_STEPS_MAX);
            assertWorkoutKeepsTheSession(session.steps, paces, SESSION_TYPE_NAMES[session.type]);
          }
        }),
        { numRuns: 100 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it("keeps any custom workout's structure, ends, targets and time on the watch", () => {
    fc.assert(
      fc.property(stepsArb, pacesArb, nameArb, (steps, paces, name) =>
        assertWorkoutKeepsTheSession(steps, paces, name),
      ),
      { numRuns: 500 },
    );
  });

  it("is deterministic and leaves its input unchanged", () => {
    fc.assert(
      fc.property(stepsArb, pacesArb, nameArb, (steps, paces, name) => {
        const before = structuredClone({ name, steps, paces });
        const once = JSON.stringify(garminWorkout({ name, steps, paces }));
        expect(JSON.stringify(garminWorkout({ name, steps, paces }))).toBe(once);
        expect(JSON.stringify(garminWorkout(structuredClone(before)))).toBe(once);
        expect({ name, steps, paces }).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});
