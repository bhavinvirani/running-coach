import { createServer } from "node:net";
import { ErrorCode } from "@running-coach/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGarminClient, garminClient } from "../../src/garmin/client";
import { config } from "../../src/lib/config";
import { DomainError } from "../../src/lib/errors";
import { withRequestId } from "../../src/lib/logger";
import { garminBundle } from "../seed";

// Against the real Garmin service in fixture mode (global-setup.ts); the bundle picks the behaviour.

const range = { startDate: "2026-09-01", endDate: "2026-09-30" };

/** Counts calls to the service while letting them through. */
function countServiceCalls(path: string) {
  const spy = vi.spyOn(globalThis, "fetch");
  const href = (input: string | URL | Request) =>
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return () => spy.mock.calls.filter(([input]) => href(input).endsWith(path)).length;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("garminClient", () => {
  it("returns the profile and the unchanged bundle", async () => {
    const response = await garminClient.profile({ tokenBundle: garminBundle() });

    expect(response.tokenBundle).toBe(garminBundle());
    expect(response.profile.displayName).toBe("Alex Fixture");
  });

  it("returns the runs in the range, parsed with the shared schema, and forwards the request id", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const response = await withRequestId("req-sync-1", () =>
      garminClient.sync({ tokenBundle: garminBundle(), ...range }),
    );

    expect(response.activities.length).toBeGreaterThanOrEqual(5);
    expect(response.activities.every((run) => run.startLocal.startsWith("2026-09"))).toBe(true);
    const headers = new Headers(spy.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-request-id")).toBe("req-sync-1");
    expect(headers.get("x-garmin-secret")).toBe(config.GARMIN_SERVICE_SECRET);
  });

  it("returns the rotated bundle when Garmin refreshed the tokens", async () => {
    const response = await garminClient.sync({ tokenBundle: garminBundle("rotate"), ...range });

    expect(JSON.parse(response.tokenBundle)).toMatchObject({ fixture: "rotated" });
  });

  it("throws garmin_auth_expired (409, not 401) when Garmin rejects the bundle", async () => {
    const error = await rejection(
      garminClient.sync({ tokenBundle: garminBundle("expired"), ...range }),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: ErrorCode.garminAuthExpired, status: 409 });
  });

  it("does not retry a 429 and carries retryAfterSeconds", async () => {
    const calls = countServiceCalls("/sync");

    const error = await rejection(
      garminClient.sync({ tokenBundle: garminBundle("rate_limited"), ...range }),
    );

    expect(error).toMatchObject({
      code: ErrorCode.garminRateLimited,
      status: 429,
      retryAfterSeconds: 3600,
    });
    expect(calls()).toBe(1);
  });

  it("retries garmin_unavailable twice, then throws it", async () => {
    const calls = countServiceCalls("/sync");

    const error = await rejection(
      garminClient.sync({ tokenBundle: garminBundle("unavailable"), ...range }),
    );

    expect(error).toMatchObject({ code: ErrorCode.garminUnavailable, status: 502 });
    expect(calls()).toBe(3);
  });

  it("throws garmin_unavailable when the service is not running", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    const client = createGarminClient({
      baseUrl: `http://127.0.0.1:${port}`,
      secret: config.GARMIN_SERVICE_SECRET,
    });

    const error = await rejection(client.profile({ tokenBundle: garminBundle() }));

    expect(error).toMatchObject({ code: ErrorCode.garminUnavailable });
  });

  it("fails as an internal error, not a Garmin one, when the shared secret is wrong", async () => {
    const client = createGarminClient({
      baseUrl: `http://127.0.0.1:${config.GARMIN_SERVICE_PORT}`,
      secret: "not-the-test-secret-value",
    });

    const error = await rejection(client.profile({ tokenBundle: garminBundle() }));

    expect(error).not.toBeInstanceOf(DomainError);
    expect(String(error)).toContain("shared secret");
  });

  it("rejects a request that breaks the contract before calling the service", async () => {
    const calls = countServiceCalls("/sync");

    await expect(
      garminClient.sync({
        tokenBundle: garminBundle(),
        startDate: "1 Sept",
        endDate: "2026-09-30",
      }),
    ).rejects.toThrow();
    expect(calls()).toBe(0);
  });
});
