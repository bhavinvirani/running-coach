import { describe, expect, it } from "vitest";
import { syncResponseSchema } from "./sync";

describe("syncResponseSchema", () => {
  it("rejects a negative count", () => {
    const parsed = syncResponseSchema.safeParse({
      lastSyncAt: "2026-09-27T05:12:00Z",
      activitiesWritten: -1,
    });
    expect(parsed.success).toBe(false);
  });
});
