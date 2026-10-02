import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../../src/lib/rate-limit";

const MINUTE = 60_000;

/** A limiter of `limit` per minute on a clock the test moves. */
function limiterAt(limit: number) {
  let now = 0;
  const limiter = createRateLimiter({ limit, windowMs: MINUTE, now: () => now });
  const at = (ms: number) => {
    now = ms;
    return limiter;
  };
  return { limiter, at };
}

describe("createRateLimiter", () => {
  it("allows the limit in a minute and refuses the next with the seconds until the oldest leaves", () => {
    const { limiter, at } = limiterAt(6);
    for (let second = 0; second < 6; second += 1) {
      expect(at(second * 1000).take("user-a")).toEqual({ allowed: true });
    }

    expect(at(10_500).take("user-a")).toEqual({ allowed: false, retryAfterSeconds: 50 });
    expect(limiter.take("user-a").allowed).toBe(false);
  });

  it("slides the window, so a burst at the end of one minute blocks the start of the next", () => {
    const { at } = limiterAt(2);
    at(0).take("user-a");
    at(50_000).take("user-a");

    expect(at(60_000).take("user-a")).toEqual({ allowed: true });
    // A fixed window that reset at 60 s would allow this one.
    expect(at(61_000).take("user-a")).toEqual({ allowed: false, retryAfterSeconds: 49 });
  });

  it("does not count refused requests, so retrying while limited does not extend the wait", () => {
    const { at } = limiterAt(1);
    at(0).take("user-a");
    for (let ms = 1000; ms < MINUTE; ms += 1000) at(ms).take("user-a");

    expect(at(MINUTE).take("user-a")).toEqual({ allowed: true });
  });

  it("rounds a wait under a second up to one second", () => {
    const { at } = limiterAt(1);
    at(0).take("user-a");

    expect(at(MINUTE - 1).take("user-a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("keeps a separate count per key", () => {
    const { at } = limiterAt(1);
    at(0).take("user-a");

    expect(at(1000).take("user-a").allowed).toBe(false);
    expect(at(1000).take("user-b")).toEqual({ allowed: true });
  });

  it("forgets every key on reset", () => {
    const { limiter, at } = limiterAt(1);
    at(0).take("user-a");

    limiter.reset();

    expect(at(1000).take("user-a")).toEqual({ allowed: true });
  });

  it("keeps limiting an active key when the sweep drops idle ones", () => {
    const { at } = limiterAt(1);
    at(0).take("idle");
    at(50_000).take("user-a");

    // A minute after the last sweep: "idle" has left the window and is dropped, "user-a" has not.
    at(60_000).take("user-b");

    expect(at(70_000).take("user-a")).toEqual({ allowed: false, retryAfterSeconds: 40 });
    expect(at(70_000).take("idle")).toEqual({ allowed: true });
  });
});
