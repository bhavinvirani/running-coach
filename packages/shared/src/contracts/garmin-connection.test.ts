import { describe, expect, it } from "vitest";
import { connectGarminRequestSchema } from "./garmin-connection";

describe("connectGarminRequestSchema", () => {
  it("rejects a user id so a client cannot connect another account", () => {
    const parsed = connectGarminRequestSchema.safeParse({ tokenBundle: "{}", userId: "x" });
    expect(parsed.success).toBe(false);
  });
});
