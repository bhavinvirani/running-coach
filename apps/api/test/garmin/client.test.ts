import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { ErrorCode } from "@running-coach/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createGarminClient, type GarminCallOptions, garminClient } from "../../src/garmin/client";
import { config } from "../../src/lib/config";
import { DomainError } from "../../src/lib/errors";
import { withRequestId } from "../../src/lib/logger";
import { fixtureOf, fixturesSentTo, garminBundle } from "../seed";

// Against the real Garmin service in fixture mode (global-setup.ts); the bundle picks the behaviour.

const range = { startDate: "2026-09-01", endDate: "2026-09-30" };

/** Records every bundle the client hands over for writing back. */
function writeBack(): GarminCallOptions & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    onTokenBundle: (tokenBundle) => {
      saved.push(tokenBundle);
      return Promise.resolve();
    },
  };
}

/** Counts calls to the service while letting them through. */
function countServiceCalls(path: string): () => number {
  const sent = fixturesSentTo(path);
  return () => sent().length;
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
  it("returns the profile and the unchanged bundle, and hands nothing over to write back", async () => {
    const options = writeBack();

    const response = await garminClient.profile({ tokenBundle: garminBundle() }, options);

    expect(response.tokenBundle).toBe(garminBundle());
    expect(response.profile.displayName).toBe("Alex Fixture");
    expect(options.saved).toEqual([]);
  });

  it("returns the runs in the range, parsed with the shared schema, and forwards the request id", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const response = await withRequestId("req-sync-1", () =>
      garminClient.sync({ tokenBundle: garminBundle(), ...range }, writeBack()),
    );

    expect(response.activities.length).toBeGreaterThanOrEqual(5);
    expect(response.activities.every((run) => run.startLocal.startsWith("2026-09"))).toBe(true);
    const headers = new Headers(spy.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-request-id")).toBe("req-sync-1");
    expect(headers.get("x-garmin-secret")).toBe(config.GARMIN_SERVICE_SECRET);
  });

  it("returns the rotated bundle when Garmin refreshed the tokens", async () => {
    const options = writeBack();

    const response = await garminClient.sync(
      { tokenBundle: garminBundle("rotate"), ...range },
      options,
    );

    expect(fixtureOf(response.tokenBundle)).toBe("rotated");
    expect(options.saved).toEqual([response.tokenBundle]);
  });

  it("throws garmin_auth_expired (409, not 401) when Garmin rejects the bundle", async () => {
    const error = await rejection(
      garminClient.sync({ tokenBundle: garminBundle("expired"), ...range }, writeBack()),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: ErrorCode.garminAuthExpired, status: 409 });
  });

  it("does not retry a 429 and carries retryAfterSeconds", async () => {
    const calls = countServiceCalls("/sync");

    const error = await rejection(
      garminClient.sync({ tokenBundle: garminBundle("rate_limited"), ...range }, writeBack()),
    );

    expect(error).toMatchObject({
      code: ErrorCode.garminRateLimited,
      status: 429,
      retryAfterSeconds: 3600,
    });
    expect(calls()).toBe(1);
  });

  it("does not retry a garmin_unavailable answer: the service already retried inside its session", async () => {
    const calls = countServiceCalls("/sync");

    const error = await rejection(
      garminClient.sync({ tokenBundle: garminBundle("unavailable"), ...range }, writeBack()),
    );

    expect(error).toMatchObject({ code: ErrorCode.garminUnavailable, status: 502 });
    expect(calls()).toBe(1);
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

    const error = await rejection(client.profile({ tokenBundle: garminBundle() }, writeBack()));

    expect(error).toMatchObject({ code: ErrorCode.garminUnavailable });
  });

  it("fails as an internal error, not a Garmin one, when the shared secret is wrong", async () => {
    const client = createGarminClient({
      baseUrl: `http://127.0.0.1:${config.GARMIN_SERVICE_PORT}`,
      secret: "not-the-test-secret-value",
    });

    const error = await rejection(client.profile({ tokenBundle: garminBundle() }, writeBack()));

    expect(error).not.toBeInstanceOf(DomainError);
    expect(String(error)).toContain("shared secret");
  });

  it("rejects a request that breaks the contract before calling the service", async () => {
    const calls = countServiceCalls("/sync");

    await expect(
      garminClient.sync(
        { tokenBundle: garminBundle(), startDate: "1 Sept", endDate: "2026-09-30" },
        writeBack(),
      ),
    ).rejects.toThrow();
    expect(calls()).toBe(0);
  });

  it("writes back the bundle Garmin rotated before a 429, then throws garmin_rate_limited (rotate then 429)", async () => {
    const events: string[] = [];
    const calls = countServiceCalls("/sync");

    const error = await rejection(
      garminClient
        .sync(
          { tokenBundle: garminBundle("rotate_then_rate_limited"), ...range },
          {
            onTokenBundle: async (tokenBundle) => {
              await sleep(20);
              events.push(`saved ${String(fixtureOf(tokenBundle))}`);
            },
          },
        )
        .finally(() => events.push("settled")),
    );

    expect(error).toMatchObject({ code: ErrorCode.garminRateLimited, retryAfterSeconds: 3600 });
    // Written back before the call failed, and the 429 was not retried.
    expect(events).toEqual(["saved rotated", "settled"]);
    expect(calls()).toBe(1);
  });

  it("writes back the bundle Garmin rotated before a 502, then throws garmin_unavailable without a retry (rotate then 502)", async () => {
    const sent = fixturesSentTo("/sync");
    const options = writeBack();

    const error = await rejection(
      garminClient.sync(
        { tokenBundle: garminBundle("rotate_then_unavailable"), ...range },
        options,
      ),
    );

    expect(error).toMatchObject({ code: ErrorCode.garminUnavailable, status: 502 });
    expect(sent()).toEqual(["rotate_then_unavailable"]);
    expect(options.saved.map(fixtureOf)).toEqual(["rotated"]);
  });

  it("throws the write-back failure and does not retry when storing a rotated bundle fails", async () => {
    const calls = countServiceCalls("/sync");

    const error = await rejection(
      garminClient.sync(
        { tokenBundle: garminBundle("rotate_then_unavailable"), ...range },
        { onTokenBundle: () => Promise.reject(new Error("database down")) },
      ),
    );

    expect(String(error)).toContain("database down");
    expect(calls()).toBe(1);
  });

  it("returns one history page newest first with what Garmin listed, non-runs left out (history page)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const response = await withRequestId("req-history-1", () =>
      garminClient.history({ tokenBundle: garminBundle(), start: 0, limit: 10 }, writeBack()),
    );

    // The fixture account's ten newest items hold one walk.
    expect(response.listed).toBe(10);
    expect(response.activities.map((run) => run.garminActivityId)).toEqual([
      10_000_000_007, 10_000_000_006, 10_000_000_005, 10_000_000_004, 10_000_000_003,
      10_000_000_002, 10_000_000_001, 9_000_000_042, 9_000_000_041,
    ]);
    expect(new Headers(spy.mock.calls[0]?.[1]?.headers).get("x-request-id")).toBe("req-history-1");
  });

  it("lists fewer than the limit on the last history page (history end)", async () => {
    const response = await garminClient.history(
      { tokenBundle: garminBundle(), start: 40, limit: 10 },
      writeBack(),
    );

    expect(response.listed).toBe(9);
    expect(response.activities.at(-1)?.startLocal).toBe("2023-09-17T09:00:00");
  });

  it("hands over the bundle Garmin rotated during a history page (rotated token)", async () => {
    const options = writeBack();

    const response = await garminClient.history(
      { tokenBundle: garminBundle("rotate"), start: 0, limit: 10 },
      options,
    );

    expect(fixtureOf(response.tokenBundle)).toBe("rotated");
    expect(options.saved).toEqual([response.tokenBundle]);
  });

  it("does not retry a 429 on a history page and carries retryAfterSeconds (Garmin 429)", async () => {
    const calls = countServiceCalls("/history");

    const error = await rejection(
      garminClient.history(
        { tokenBundle: garminBundle("rate_limited"), start: 0, limit: 10 },
        writeBack(),
      ),
    );

    expect(error).toMatchObject({ code: ErrorCode.garminRateLimited, retryAfterSeconds: 3600 });
    expect(calls()).toBe(1);
  });

  it("rejects a history page over the contract's limit before calling the service", async () => {
    const calls = countServiceCalls("/history");

    await expect(
      garminClient.history({ tokenBundle: garminBundle(), start: 0, limit: 500 }, writeBack()),
    ).rejects.toThrow();
    expect(calls()).toBe(0);
  });

  describe("against a service that drops the first connection, as while its process restarts", () => {
    let server: Server;
    let client: ReturnType<typeof createGarminClient>;
    let requests = 0;

    beforeAll(async () => {
      server = createHttpServer((req, res) => {
        requests += 1;
        if (requests === 1) {
          req.socket.destroy();
          return;
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ tokenBundle: garminBundle(), profile: { displayName: "Alex" } }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      client = createGarminClient({ baseUrl: `http://127.0.0.1:${port}`, secret: "unused" });
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("retries a request that got no answer at all", async () => {
      const response = await client.profile({ tokenBundle: garminBundle() }, writeBack());

      expect(response.profile.displayName).toBe("Alex");
      expect(requests).toBe(2);
    });
  });

  describe("against a service that breaks the contract", () => {
    let server: Server;
    let client: ReturnType<typeof createGarminClient>;
    const rotated = garminBundle("rotated");

    beforeAll(async () => {
      server = createHttpServer((_req, res) => {
        // A rotated bundle beside an activity the shared schema rejects.
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ tokenBundle: rotated, activities: [{ garminActivityId: -1 }] }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      client = createGarminClient({ baseUrl: `http://127.0.0.1:${port}`, secret: "unused" });
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("still writes back the bundle of a 2xx answer that breaks the contract, then throws garmin_unavailable", async () => {
      const options = writeBack();

      const error = await rejection(
        client.sync({ tokenBundle: garminBundle(), ...range }, options),
      );

      expect(error).toMatchObject({ code: ErrorCode.garminUnavailable, status: 502 });
      expect(options.saved).toEqual([rotated]);
    });
  });
});
