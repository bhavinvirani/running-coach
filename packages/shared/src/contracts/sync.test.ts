import { describe, expect, it } from "vitest";
import { cronSyncResponseSchema, syncResponseSchema } from "./sync";

describe("syncResponseSchema", () => {
  const synced = { lastSyncAt: "2026-09-27T05:12:00Z", activitiesWritten: 1, activitiesRemoved: 0 };

  it("accepts a sync that wrote and removed runs", () => {
    expect(syncResponseSchema.parse({ ...synced, activitiesRemoved: 2 })).toEqual({
      ...synced,
      activitiesRemoved: 2,
    });
  });

  it("rejects a negative count", () => {
    expect(syncResponseSchema.safeParse({ ...synced, activitiesWritten: -1 }).success).toBe(false);
    expect(syncResponseSchema.safeParse({ ...synced, activitiesRemoved: -1 }).success).toBe(false);
  });

  it("requires the removed count", () => {
    const { activitiesRemoved: _, ...withoutRemoved } = synced;
    expect(syncResponseSchema.safeParse(withoutRemoved).success).toBe(false);
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
