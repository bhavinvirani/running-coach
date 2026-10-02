import { describe, expect, it } from "vitest";
import { DISTANCE_METERS } from "../distances";
import {
  DAYS_PER_WEEK_MAX,
  DAYS_PER_WEEK_MIN,
  goalInputSchema,
  goalSchema,
  raceDistanceKeySchema,
} from "./goal";

const raceGoal = {
  kind: "race",
  distanceKey: "half",
  raceDate: "2027-03-14",
  targetTimeS: 6600,
  daysPerWeek: 4,
  longRunDay: "sun",
  recentTime: null,
};

const fitnessGoal = {
  kind: "fitness",
  distanceKey: null,
  raceDate: null,
  targetTimeS: null,
  daysPerWeek: 3,
  longRunDay: "sat",
  recentTime: { distanceKey: "5k", timeS: 1650 },
};

describe("raceDistanceKeySchema", () => {
  it("offers the four road races, each a known distance", () => {
    expect(raceDistanceKeySchema.options).toEqual(["5k", "10k", "half", "marathon"]);
    for (const key of raceDistanceKeySchema.options) {
      expect(DISTANCE_METERS[key]).toBeGreaterThan(0);
    }
  });
});

describe("goalInputSchema", () => {
  it("accepts a race goal with a target time", () => {
    expect(goalInputSchema.safeParse(raceGoal).success).toBe(true);
  });

  it("accepts a fitness goal with an entered recent time and no distance", () => {
    expect(goalInputSchema.safeParse(fitnessGoal).success).toBe(true);
  });

  it("rejects a race goal without a distance or a date, naming each field", () => {
    const parsed = goalInputSchema.safeParse({ ...raceGoal, distanceKey: null, raceDate: null });
    expect(parsed.success).toBe(false);
    const paths = parsed.error?.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(["distanceKey", "raceDate"]);
  });

  it("rejects a fitness goal with a race date or a target time", () => {
    expect(goalInputSchema.safeParse({ ...fitnessGoal, raceDate: "2027-03-14" }).success).toBe(
      false,
    );
    expect(goalInputSchema.safeParse({ ...fitnessGoal, targetTimeS: 3000 }).success).toBe(false);
  });

  it(`keeps days per week between ${DAYS_PER_WEEK_MIN} and ${DAYS_PER_WEEK_MAX}`, () => {
    expect(goalInputSchema.safeParse({ ...raceGoal, daysPerWeek: DAYS_PER_WEEK_MIN }).success).toBe(
      true,
    );
    expect(goalInputSchema.safeParse({ ...raceGoal, daysPerWeek: DAYS_PER_WEEK_MAX }).success).toBe(
      true,
    );
    expect(
      goalInputSchema.safeParse({ ...raceGoal, daysPerWeek: DAYS_PER_WEEK_MIN - 1 }).success,
    ).toBe(false);
    expect(
      goalInputSchema.safeParse({ ...raceGoal, daysPerWeek: DAYS_PER_WEEK_MAX + 1 }).success,
    ).toBe(false);
  });

  it("rejects a distance outside the four races, a date with a time, and an unknown field", () => {
    expect(goalInputSchema.safeParse({ ...raceGoal, distanceKey: "10mi" }).success).toBe(false);
    expect(
      goalInputSchema.safeParse({ ...raceGoal, raceDate: "2027-03-14T09:00:00Z" }).success,
    ).toBe(false);
    expect(goalInputSchema.safeParse({ ...raceGoal, paceSPerKm: 300 }).success).toBe(false);
  });

  it("rejects a recent time that is not whole positive seconds", () => {
    expect(
      goalInputSchema.safeParse({ ...raceGoal, recentTime: { distanceKey: "5k", timeS: 0 } })
        .success,
    ).toBe(false);
    expect(
      goalInputSchema.safeParse({ ...raceGoal, recentTime: { distanceKey: "5k", timeS: 1650.5 } })
        .success,
    ).toBe(false);
  });
});

describe("goalSchema", () => {
  it("is the input plus its row identity", () => {
    const parsed = goalSchema.safeParse({
      ...raceGoal,
      id: "8f0c8a52-3d8e-4a77-9a39-6c1f1b0e2a11",
      updatedAt: "2026-10-02T08:00:00Z",
    });
    expect(parsed.success).toBe(true);
  });
});
