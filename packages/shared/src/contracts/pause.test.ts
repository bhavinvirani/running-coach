import { describe, expect, it } from "vitest";
import { endPauseResponseSchema, pauseResponseSchema, startPauseRequestSchema } from "./pause";

const pause = {
  id: "6f5c0c5e-4a0a-4e8f-9e4c-0f1e6c4a5b66",
  reason: "sick",
  startDate: "2026-10-06",
  createdAt: "2026-10-06T07:00:00.000Z",
};

describe("startPauseRequestSchema", () => {
  it("accepts each reason and nothing else", () => {
    for (const reason of ["sick", "injured", "break"]) {
      expect(startPauseRequestSchema.safeParse({ reason }).success).toBe(true);
    }
    expect(startPauseRequestSchema.safeParse({ reason: "bored" }).success).toBe(false);
    expect(startPauseRequestSchema.safeParse({ reason: "sick", days: 7 }).success).toBe(false);
  });
});

describe("pauseResponseSchema", () => {
  it("accepts an open pause or none", () => {
    expect(pauseResponseSchema.safeParse({ pause }).success).toBe(true);
    expect(pauseResponseSchema.safeParse({ pause: null }).success).toBe(true);
  });
});

describe("endPauseResponseSchema", () => {
  it("accepts the re-entry, or null when no pause was open", () => {
    const reEntry = {
      daysOff: 9,
      factor: 0.7,
      walkRun: true,
      fromDate: "2026-10-15",
      sessionsChanged: 6,
    };
    expect(endPauseResponseSchema.safeParse({ pause: null, reEntry }).success).toBe(true);
    expect(endPauseResponseSchema.safeParse({ pause: null, reEntry: null }).success).toBe(true);
    expect(
      endPauseResponseSchema.safeParse({ pause: null, reEntry: { ...reEntry, factor: 1.2 } })
        .success,
    ).toBe(false);
  });
});
