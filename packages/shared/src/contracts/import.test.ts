import { describe, expect, it } from "vitest";
import { importProgressSchema } from "./import";

const notStarted = {
  status: "not_started",
  runsStored: 0,
  oldestDate: null,
  startedAt: null,
  finishedAt: null,
  resumeAt: null,
  errorCode: null,
};

describe("importProgressSchema", () => {
  it("accepts an import that never ran", () => {
    expect(importProgressSchema.safeParse(notStarted).success).toBe(true);
  });

  it("accepts a paused import with the time it continues", () => {
    const paused = {
      ...notStarted,
      status: "paused",
      runsStored: 340,
      oldestDate: "2021-03-14",
      startedAt: "2026-10-02T09:00:00Z",
      resumeAt: "2026-10-02T10:05:00Z",
      errorCode: "garmin_rate_limited",
    };
    expect(importProgressSchema.safeParse(paused).success).toBe(true);
  });

  it("rejects an error code outside the shared list", () => {
    const parsed = importProgressSchema.safeParse({ ...notStarted, errorCode: "boom" });
    expect(parsed.success).toBe(false);
  });
});
