import { describe, expect, it } from "vitest";
import { hrZonesResponseSchema, hrZonesSchema } from "./hr-zones";

const garminZones = { maxHr: 196, lowBpm: [98, 118, 137, 157, 176] };

describe("hrZonesSchema", () => {
  it("accepts five rising floors below max HR", () => {
    expect(hrZonesSchema.safeParse(garminZones).success).toBe(true);
  });

  it("rejects floors that do not rise", () => {
    expect(
      hrZonesSchema.safeParse({ ...garminZones, lowBpm: [98, 118, 118, 157, 176] }).success,
    ).toBe(false);
    expect(
      hrZonesSchema.safeParse({ ...garminZones, lowBpm: [98, 140, 137, 157, 176] }).success,
    ).toBe(false);
  });

  it("rejects zone 5 at or above max HR", () => {
    expect(
      hrZonesSchema.safeParse({ ...garminZones, lowBpm: [98, 118, 137, 157, 196] }).success,
    ).toBe(false);
  });

  it("rejects a max HR outside 100 to 240 and a zone 1 under 30 bpm", () => {
    expect(hrZonesSchema.safeParse({ ...garminZones, maxHr: 99 }).success).toBe(false);
    expect(hrZonesSchema.safeParse({ ...garminZones, maxHr: 241 }).success).toBe(false);
    expect(
      hrZonesSchema.safeParse({ ...garminZones, lowBpm: [29, 118, 137, 157, 176] }).success,
    ).toBe(false);
  });

  it("rejects fractions, four or six zones and unknown fields", () => {
    expect(hrZonesSchema.safeParse({ ...garminZones, maxHr: 196.5 }).success).toBe(false);
    expect(hrZonesSchema.safeParse({ ...garminZones, lowBpm: [98, 118, 137, 157] }).success).toBe(
      false,
    );
    expect(
      hrZonesSchema.safeParse({ ...garminZones, lowBpm: [98, 118, 137, 157, 176, 186] }).success,
    ).toBe(false);
    expect(hrZonesSchema.safeParse({ ...garminZones, userId: "x" }).success).toBe(false);
  });
});

describe("hrZonesResponseSchema", () => {
  it("accepts zones from any source and null zones", () => {
    expect(hrZonesResponseSchema.safeParse({ source: "garmin", zones: garminZones }).success).toBe(
      true,
    );
    expect(hrZonesResponseSchema.safeParse({ source: "none", zones: null }).success).toBe(true);
  });
});
