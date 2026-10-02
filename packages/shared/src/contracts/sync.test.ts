import { describe, expect, it } from "vitest";
import { cronSyncResponseSchema, syncResponseSchema } from "./sync";

describe("syncResponseSchema", () => {
  it("rejects a negative count", () => {
    const parsed = syncResponseSchema.safeParse({
      lastSyncAt: "2026-09-27T05:12:00Z",
      activitiesWritten: -1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("cronSyncResponseSchema", () => {
  it("accepts a fire that queued nothing", () => {
    expect(cronSyncResponseSchema.parse({ connected: 1, queued: 0 })).toEqual({
      connected: 1,
      queued: 0,
    });
  });

  it("rejects a negative or fractional count and unknown keys", () => {
    expect(cronSyncResponseSchema.safeParse({ connected: -1, queued: 0 }).success).toBe(false);
    expect(cronSyncResponseSchema.safeParse({ connected: 1, queued: 0.5 }).success).toBe(false);
    expect(cronSyncResponseSchema.safeParse({ connected: 1, queued: 0, users: [] }).success).toBe(
      false,
    );
  });
});
