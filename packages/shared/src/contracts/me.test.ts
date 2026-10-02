import { describe, expect, it } from "vitest";
import { updateSettingsRequestSchema } from "./me";

describe("updateSettingsRequestSchema", () => {
  it("accepts a single setting", () => {
    expect(updateSettingsRequestSchema.safeParse({ units: "mi" }).success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(updateSettingsRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unknown time zone and accepts an IANA one", () => {
    expect(updateSettingsRequestSchema.safeParse({ timezone: "Mars/Olympus" }).success).toBe(false);
    expect(updateSettingsRequestSchema.safeParse({ timezone: "America/Chicago" }).success).toBe(
      true,
    );
  });

  it("rejects unknown fields so a client cannot set the user id", () => {
    expect(updateSettingsRequestSchema.safeParse({ units: "km", userId: "x" }).success).toBe(false);
  });
});
