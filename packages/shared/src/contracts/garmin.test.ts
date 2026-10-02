import { describe, expect, it } from "vitest";
import { garminProblemSchema } from "./garmin";
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
