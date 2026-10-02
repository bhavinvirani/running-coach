import { describe, expect, it } from "vitest";
import {
  garminHistoryRequestSchema,
  garminHistoryResponseSchema,
  garminProblemSchema,
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
