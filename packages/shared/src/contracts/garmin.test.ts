import { describe, expect, it } from "vitest";
import {
  GARMIN_WORKOUT_NAME_MAX,
  garminHistoryRequestSchema,
  garminHistoryResponseSchema,
  garminProblemSchema,
  garminWorkoutName,
  garminWorkoutSchema,
  garminWorkoutSyncRequestSchema,
} from "./garmin";
import { problemSchema } from "./problem";

const rateLimited = {
  type: "about:blank",
  title: "Too Many Requests",
  status: 429,
  code: "garmin_rate_limited",
  retryAfterSeconds: 3600,
};
const rotated = '{"di_token":"t","di_refresh_token":"r2","di_client_id":"c"}';

describe("garminProblemSchema", () => {
  it("accepts a service problem that carries a rotated bundle", () => {
    expect(garminProblemSchema.parse({ ...rateLimited, tokenBundle: rotated })).toMatchObject({
      tokenBundle: rotated,
    });
  });

  it("accepts a service problem without a bundle", () => {
    expect(garminProblemSchema.safeParse(rateLimited).success).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(garminProblemSchema.safeParse({ ...rateLimited, extra: 1 }).success).toBe(false);
  });
});

describe("problemSchema", () => {
  it("rejects a tokenBundle, so the public API can never send one to the browser", () => {
    expect(problemSchema.safeParse({ ...rateLimited, tokenBundle: rotated }).success).toBe(false);
  });
});

describe("garminHistoryRequestSchema", () => {
  const request = { tokenBundle: rotated, start: 0, limit: 100 };

  it("accepts the first page", () => {
    expect(garminHistoryRequestSchema.safeParse(request).success).toBe(true);
  });

  it("rejects a page larger than 200, which would make one Garmin call too slow", () => {
    expect(garminHistoryRequestSchema.safeParse({ ...request, limit: 201 }).success).toBe(false);
  });

  it("rejects a negative offset", () => {
    expect(garminHistoryRequestSchema.safeParse({ ...request, start: -1 }).success).toBe(false);
  });
});

describe("garminHistoryResponseSchema", () => {
  it("rejects a page without the listed count the cursor advances by", () => {
    expect(
      garminHistoryResponseSchema.safeParse({ tokenBundle: rotated, activities: [] }).success,
    ).toBe(false);
  });
});

describe("garminWorkoutName", () => {
  // " 8.0 km" leaves 53 UTF-16 units of the 60 for the title.
  const session = (title: string | null) => ({
    title,
    type: "easy" as const,
    target: { distanceM: 8000, durationS: 2880, zone: "easy" as const },
  });
  const runner = "\u{1F3C3}";

  it("drops an emoji exactly at the cut whole, never leaving half of it (emoji at the cut)", () => {
    // The emoji's two UTF-16 units are the 53rd and 54th: slicing by units would keep only the first.
    const name = garminWorkoutName(session(`${"x".repeat(52)}${runner} hills`), "km");

    expect(name).toBe(`${"x".repeat(52)} 8.0 km`);
    expect(name.isWellFormed()).toBe(true);
    expect(garminWorkoutSchema.shape.name.safeParse(name).success).toBe(true);
  });

  it("keeps an emoji that fits before the cut, within the cap in UTF-16 units (emoji at the cut)", () => {
    const name = garminWorkoutName(session(`${"x".repeat(51)}${runner} hills`), "km");

    expect(name).toBe(`${"x".repeat(51)}${runner} 8.0 km`);
    expect(name).toHaveLength(GARMIN_WORKOUT_NAME_MAX);
  });

  it("stays within the cap for a title of emoji only (emoji at the cut)", () => {
    const name = garminWorkoutName(session(runner.repeat(GARMIN_WORKOUT_NAME_MAX)), "km");

    expect(name).toBe(`${runner.repeat(26)} 8.0 km`);
    expect(name.length).toBeLessThanOrEqual(GARMIN_WORKOUT_NAME_MAX);
    expect(name.isWellFormed()).toBe(true);
  });

  it("replaces a lone surrogate in the title, which the Garmin service would reject with the whole batch", () => {
    const name = garminWorkoutName(session("Hill \uD83D reps"), "km");

    expect(name).toBe("Hill \uFFFD reps 8.0 km");
    expect(name.isWellFormed()).toBe(true);
  });
});

describe("garminWorkoutSyncRequestSchema", () => {
  const request = {
    tokenBundle: rotated,
    actions: [],
    calendarStart: "2026-10-01",
    calendarEnd: "2026-10-07",
  };

  it("requires readCalendar, so every caller says whether it needs the calendar back", () => {
    expect(garminWorkoutSyncRequestSchema.safeParse(request).success).toBe(false);
    expect(
      garminWorkoutSyncRequestSchema.safeParse({ ...request, readCalendar: false }).success,
    ).toBe(true);
  });
});
