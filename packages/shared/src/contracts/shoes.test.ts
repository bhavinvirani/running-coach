import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOE_RETIRE_DISTANCE_M,
  MAX_SHOE_RETIRE_DISTANCE_M,
  MIN_SHOE_RETIRE_DISTANCE_M,
  activityShoeSchema,
  createShoeRequestSchema,
  shoeInputSchema,
  shoesResponseSchema,
} from "./shoes";

const input = {
  brand: "Northpace",
  model: "Glide 4",
  colour: null,
  nickname: null,
  retireDistanceM: DEFAULT_SHOE_RETIRE_DISTANCE_M,
  startDistanceM: 0,
};

describe("shoeInputSchema", () => {
  it("trims the text and keeps the optional fields null", () => {
    const parsed = shoeInputSchema.parse({ ...input, brand: "  Northpace ", nickname: " Daily " });
    expect(parsed).toMatchObject({ brand: "Northpace", nickname: "Daily", colour: null });
  });

  it("refuses a blank brand or model, and an empty optional field instead of null", () => {
    expect(shoeInputSchema.safeParse({ ...input, brand: "   " }).success).toBe(false);
    expect(shoeInputSchema.safeParse({ ...input, model: "" }).success).toBe(false);
    expect(shoeInputSchema.safeParse({ ...input, colour: "" }).success).toBe(false);
  });

  it("holds the retire goal and start distance to whole meters in range", () => {
    for (const retireDistanceM of [MIN_SHOE_RETIRE_DISTANCE_M, MAX_SHOE_RETIRE_DISTANCE_M]) {
      expect(shoeInputSchema.safeParse({ ...input, retireDistanceM }).success).toBe(true);
    }
    for (const retireDistanceM of [MIN_SHOE_RETIRE_DISTANCE_M - 1, 650_000.5]) {
      expect(shoeInputSchema.safeParse({ ...input, retireDistanceM }).success).toBe(false);
    }
    expect(shoeInputSchema.safeParse({ ...input, startDistanceM: -1 }).success).toBe(false);
  });

  it("refuses unknown fields", () => {
    expect(shoeInputSchema.safeParse({ ...input, active: true }).success).toBe(false);
    expect(createShoeRequestSchema.safeParse({ ...input, active: true }).success).toBe(true);
    expect(createShoeRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe("shoesResponseSchema", () => {
  it("accepts a pair with its totals", () => {
    const shoe = {
      ...input,
      id: "6f5c0c5e-4a0a-4e8f-9e4c-0f1e6c4a5b66",
      active: true,
      retiredAt: null,
      distanceM: 312_400,
      runs: 41,
      durationS: 101_645,
    };
    expect(shoesResponseSchema.safeParse({ shoes: [shoe] }).success).toBe(true);
    expect(shoesResponseSchema.safeParse({ shoes: [{ ...shoe, runs: 1.5 }] }).success).toBe(false);
  });
});

describe("activityShoeSchema", () => {
  it("accepts a pair id or null", () => {
    expect(activityShoeSchema.safeParse({ shoeId: null }).success).toBe(true);
    expect(activityShoeSchema.safeParse({ shoeId: "nope" }).success).toBe(false);
  });
});
