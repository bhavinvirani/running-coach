import { ErrorCode, meResponseSchema } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { json, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { ApiError, apiFetch } from "./client";

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

  it("rejects a response that breaks the contract", async () => {
    stubFetch(() => json({ user: { id: "not-a-uuid" } }));
    const error = await failure(apiFetch("/api/me", { schema: meResponseSchema }));
    expect(error).toMatchObject({ status: 200, code: "internal" });
  });
});
