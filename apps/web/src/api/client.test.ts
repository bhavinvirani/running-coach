import { ErrorCode, activityResponseSchema, meResponseSchema } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { json, problem, stubFetch } from "@/test/fake-api";
import { activityDetailFixture, activityResponseFixture, meFixture } from "@/test/fixtures";
import { ApiError, apiFetch, isContractMismatch } from "./client";

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ApiError)) throw new Error("expected an ApiError");
  return error;
}

describe("apiFetch", () => {
  it("returns the response parsed with the caller's schema", async () => {
    stubFetch(() => json(meFixture()));
    await expect(apiFetch("/api/me", { schema: meResponseSchema })).resolves.toEqual(meFixture());
  });

  it("sends a fresh request id, JSON and same-origin credentials", async () => {
    const calls = stubFetch(() => json(meFixture()));
    await apiFetch("/api/me/settings", {
      method: "PATCH",
      body: { units: "mi" },
      schema: meResponseSchema,
    });
    await apiFetch("/api/me", { schema: meResponseSchema });

    const [patch, get] = calls;
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toEqual({ units: "mi" });
    expect(patch?.headers.get("content-type")).toBe("application/json");
    expect(patch?.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(get?.headers.get("x-request-id")).not.toBe(patch?.headers.get("x-request-id"));
    expect(get?.headers.get("content-type")).toBeNull();
  });

  it("turns problem+json into an ApiError with code, detail and retry hint", async () => {
    stubFetch(() =>
      problem(429, ErrorCode.garminRateLimited, {
        detail: "Garmin answered 429",
        requestId: "req-1",
        retryAfterSeconds: 3600,
      }),
    );
    const error = await failure(apiFetch("/api/me", { schema: meResponseSchema }));
    expect(error).toMatchObject({
      status: 429,
      code: "garmin_rate_limited",
      detail: "Garmin answered 429",
      requestId: "req-1",
      retryAfterSeconds: 3600,
      network: false,
    });
  });

  it("maps a non-problem error page to a code from its status", async () => {
    stubFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const error = await failure(apiFetch("/api/me", { schema: meResponseSchema }));
    expect(error).toMatchObject({ status: 502, code: "internal", network: false });
  });

  it("flags a request that never reached the server", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await failure(apiFetch("/api/me", { schema: meResponseSchema }));
    expect(error).toMatchObject({ status: 0, code: "internal", network: true });
  });

  it("drops fields this version does not know, at any depth, as a newer API sends them", async () => {
    const me = meFixture();
    stubFetch(() => json({ ...me, addedLater: 1, settings: { ...me.settings, weekStart: "mon" } }));
    await expect(apiFetch("/api/me", { schema: meResponseSchema })).resolves.toEqual(me);
  });

  it("flags a 2xx this version cannot read as a contract mismatch, and is never a network error", async () => {
    const me = meFixture();
    stubFetch(() => json({ ...me, settings: { ...me.settings, coachDetail: "brief" } }));
    const error = await failure(apiFetch("/api/me", { schema: meResponseSchema }));
    expect(error).toMatchObject({
      status: 200,
      code: "internal",
      contractMismatch: "read",
      network: false,
    });
    expect(isContractMismatch(error)).toBe(true);
  });

  it("marks a write whose 2xx it cannot read, since the server may have done it", async () => {
    stubFetch(() => json({ user: { id: "not-a-uuid" } }));
    const error = await failure(
      apiFetch("/api/me/settings", {
        method: "PATCH",
        body: { units: "mi" },
        schema: meResponseSchema,
      }),
    );
    expect(error).toMatchObject({ status: 200, contractMismatch: "write" });
  });

  it("marks an idempotent POST whose 2xx it cannot read as a read, since asking again only answers again, and any other POST as a write", async () => {
    const run = activityResponseFixture();
    const detail = activityDetailFixture();
    // A newer API renamed a lap field.
    const laps = detail.laps.map(({ avgCadence, ...lap }) => ({ ...lap, cadenceAvg: avgCadence }));
    stubFetch(() => json({ ...run, detail: { ...detail, laps } }));
    const fetchDetail = (idempotent?: boolean) =>
      failure(
        apiFetch(`/api/activities/${run.activity.id}/detail`, {
          method: "POST",
          schema: activityResponseSchema,
          idempotent,
        }),
      );

    expect(await fetchDetail(true)).toMatchObject({ status: 200, contractMismatch: "read" });
    expect(await fetchDetail()).toMatchObject({ status: 200, contractMismatch: "write" });
  });

  it("treats a 2xx page that is not JSON as no answer from the API, not a mismatch", async () => {
    stubFetch(() => new Response("<html>Sign in to the Wi-Fi</html>", { status: 200 }));
    const error = await failure(apiFetch("/api/me", { schema: meResponseSchema }));
    expect(error).toMatchObject({ network: true, contractMismatch: undefined });
  });

  it("reads a problem with a field it does not know by its code", async () => {
    stubFetch(() => problem(409, ErrorCode.garminAuthExpired, { addedLater: true } as never));
    const error = await failure(apiFetch("/api/me", { schema: meResponseSchema }));
    expect(error).toMatchObject({
      status: 409,
      code: "garmin_auth_expired",
      contractMismatch: undefined,
    });
  });
});
