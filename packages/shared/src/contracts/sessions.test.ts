import { describe, expect, it } from "vitest";
import { calendarQuerySchema, unscheduleGarminRequestSchema } from "./calendar";
import { garminWorkoutStepSchema, garminWorkoutSyncResponseSchema } from "./garmin";
import {
  customSessionInputSchema,
  GARMIN_WORKOUT_STEPS_MAX,
  garminStepCount,
  moveSessionResponseSchema,
} from "./sessions";

const warmup = { kind: "warmup", zone: "easy", distanceM: null, durationS: 600 } as const;
const work = { kind: "work", zone: "interval", distanceM: 400, durationS: null } as const;
const jog = { kind: "recovery", zone: "easy", distanceM: null, durationS: 90 } as const;
const cooldown = { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 } as const;

const custom = {
  date: "2026-10-08",
  type: "intervals",
  title: "Track 8 x 400",
  steps: [warmup, { repeat: 8, steps: [work, jog] }, cooldown],
};

describe("customSessionInputSchema", () => {
  it("accepts a warm-up, a repeat and a cool-down", () => {
    expect(customSessionInputSchema.safeParse(custom).success).toBe(true);
  });

  it("trims the title and refuses one that is only spaces", () => {
    expect(customSessionInputSchema.parse({ ...custom, title: "  Hills  " }).title).toBe("Hills");
    expect(customSessionInputSchema.safeParse({ ...custom, title: "   " }).success).toBe(false);
  });

  it("refuses a workout with no steps, a race, a rest day or strength", () => {
    expect(customSessionInputSchema.safeParse({ ...custom, steps: [] }).success).toBe(false);
    for (const type of ["race", "rest", "strength"]) {
      expect(customSessionInputSchema.safeParse({ ...custom, type }).success).toBe(false);
    }
  });

  it("refuses a step over 100 km or 6 hours and a repeat over 50", () => {
    const long = { ...warmup, durationS: 6 * 3600 + 1 };
    const far = { kind: "run", zone: "easy", distanceM: 100_001, durationS: null };
    expect(customSessionInputSchema.safeParse({ ...custom, steps: [long] }).success).toBe(false);
    expect(customSessionInputSchema.safeParse({ ...custom, steps: [far] }).success).toBe(false);
    const repeats = { ...custom, steps: [{ repeat: 51, steps: [work, jog] }] };
    expect(customSessionInputSchema.safeParse(repeats).success).toBe(false);
  });

  it("counts a repeat as one plus its steps and refuses more than Garmin's 50", () => {
    expect(garminStepCount(custom.steps as never)).toBe(5);
    const steps = Array.from({ length: GARMIN_WORKOUT_STEPS_MAX + 1 }, () => warmup);
    expect(customSessionInputSchema.safeParse({ ...custom, steps }).success).toBe(false);
    expect(customSessionInputSchema.safeParse({ ...custom, steps: steps.slice(1) }).success).toBe(
      true,
    );
  });
});

describe("calendarQuerySchema", () => {
  it("takes one day up to six weeks and refuses a range that runs backwards", () => {
    expect(calendarQuerySchema.safeParse({ from: "2026-10-05", to: "2026-10-05" }).success).toBe(
      true,
    );
    expect(calendarQuerySchema.safeParse({ from: "2026-10-05", to: "2026-11-15" }).success).toBe(
      true,
    );
    expect(calendarQuerySchema.safeParse({ from: "2026-10-05", to: "2026-11-16" }).success).toBe(
      false,
    );
    expect(calendarQuerySchema.safeParse({ from: "2026-10-05", to: "2026-10-04" }).success).toBe(
      false,
    );
  });
});

describe("unscheduleGarminRequestSchema", () => {
  it("needs at least one schedule id", () => {
    expect(unscheduleGarminRequestSchema.safeParse({ scheduleIds: [] }).success).toBe(false);
    expect(unscheduleGarminRequestSchema.safeParse({ scheduleIds: [12] }).success).toBe(true);
  });
});

describe("garminWorkoutStepSchema", () => {
  it("ends a step by distance or by time, never both", () => {
    const step = { type: "interval", distanceM: 400, durationS: null, pace: null };
    expect(garminWorkoutStepSchema.safeParse(step).success).toBe(true);
    expect(garminWorkoutStepSchema.safeParse({ ...step, durationS: 90 }).success).toBe(false);
  });
});

describe("garminWorkoutSyncResponseSchema", () => {
  it("carries the results so far and why the batch stopped", () => {
    const response = {
      tokenBundle: "{}",
      results: [
        { ref: "a", action: "create", outcome: "failed", workoutId: 7, scheduleId: null },
        { ref: "b", action: "create", outcome: "skipped", workoutId: null, scheduleId: null },
      ],
      stopped: { code: "garmin_rate_limited", retryAfterSeconds: 3600 },
      calendar: null,
    };
    expect(garminWorkoutSyncResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe("moveSessionResponseSchema", () => {
  it("needs the warning field, null when the spacing holds", () => {
    const shape = moveSessionResponseSchema.shape;
    expect(Object.keys(shape)).toEqual(["session", "paces", "garmin", "warning"]);
  });
});
