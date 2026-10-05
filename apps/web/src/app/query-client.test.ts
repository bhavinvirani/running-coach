import { ErrorCode } from "@running-coach/shared";
import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { bootRetry, createQueryClient, throwOnFirstLoadMismatch } from "./query-client";

const unauthorized = () => new ApiError({ status: 401, code: ErrorCode.unauthorized });
const invalid = () => new ApiError({ status: 400, code: ErrorCode.validation });
const unreachable = () => new ApiError({ status: 0, code: ErrorCode.internal, network: true });
const serverError = (status: number) => new ApiError({ status, code: ErrorCode.internal });
const unreadable = () =>
  new ApiError({ status: 200, code: ErrorCode.internal, contractMismatch: "read" });

async function failMutation(onUnauthorized: () => void, error: ApiError) {
  const client = createQueryClient({ onUnauthorized });
  const mutation = new MutationObserver(client, { mutationFn: () => Promise.reject(error) });
  await mutation.mutate().catch(() => undefined);
}

async function failQuery(onUnauthorized: () => void, error: ApiError) {
  const client = createQueryClient({ onUnauthorized });
  const query = new QueryObserver(client, {
    queryKey: ["me", "detail"],
    queryFn: () => Promise.reject(error),
  });
  await query.refetch();
}

describe("createQueryClient", () => {
  it("sends the user to log in when a mutation gets a 401", async () => {
    const onUnauthorized = vi.fn();
    await failMutation(onUnauthorized, unauthorized());
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("sends the user to log in when a query gets a 401", async () => {
    const onUnauthorized = vi.fn();
    await failQuery(onUnauthorized, unauthorized());
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("leaves the user where they are when a mutation fails for another reason", async () => {
    const onUnauthorized = vi.fn();
    await failMutation(onUnauthorized, invalid());
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("a 2xx this version cannot read", () => {
  it("is never retried, also while the app waits for the server at boot, and is reported once", async () => {
    const onContractMismatch = vi.fn();
    const client = createQueryClient({ onContractMismatch });
    const queryFn = vi.fn(() => Promise.reject(unreadable()));
    const query = new QueryObserver(client, { queryKey: ["me", "detail"], queryFn });
    await query.refetch();
    expect(queryFn).toHaveBeenCalledOnce();
    expect(onContractMismatch).toHaveBeenCalledOnce();
    expect(bootRetry(() => 0).retry(0, unreadable())).toBe(false);
  });

  it("is reported from a mutation too, which never throws to a boundary", async () => {
    const onContractMismatch = vi.fn();
    const client = createQueryClient({ onContractMismatch });
    const mutation = new MutationObserver(client, {
      mutationFn: () => Promise.reject(unreadable()),
    });
    await mutation.mutate().catch(() => undefined);
    expect(onContractMismatch).toHaveBeenCalledOnce();
    expect(client.getDefaultOptions().mutations?.throwOnError).toBeUndefined();
  });

  it("throws to the route's boundary on a first load, and keeps the data of a refetch on screen", () => {
    const client = createQueryClient();
    const cache = client.getQueryCache();
    const firstLoad = cache.build(client, { queryKey: ["plan", "detail"] });
    expect(throwOnFirstLoadMismatch(unreadable(), firstLoad)).toBe(true);
    expect(throwOnFirstLoadMismatch(serverError(500), firstLoad)).toBe(false);
    client.setQueryData(["plan", "detail"], { goal: null, plan: null });
    expect(throwOnFirstLoadMismatch(unreadable(), firstLoad)).toBe(false);
    expect(client.getDefaultOptions().queries?.throwOnError).toBe(throwOnFirstLoadMismatch);
  });
});

describe("bootRetry", () => {
  it("keeps retrying no answer and 502, 503, 504 for about 90 s while the server wakes (cold start)", () => {
    let now = 1_000;
    const { retry } = bootRetry(() => now);
    for (const error of [unreachable(), serverError(502), serverError(503), serverError(504)]) {
      expect(retry(12, error)).toBe(true);
    }

    now += 89_000;
    expect(retry(30, serverError(503))).toBe(true);
    now += 2_000;
    expect(retry(30, serverError(503))).toBe(false);
    expect(retry(30, unreachable())).toBe(false);
  });

  it("never retries a 4xx at boot", () => {
    const { retry } = bootRetry(() => 0);
    expect(retry(0, unauthorized())).toBe(false);
    expect(retry(0, invalid())).toBe(false);
    expect(retry(0, new ApiError({ status: 429, code: ErrorCode.rateLimited }))).toBe(false);
  });

  it("gives a 500 the usual three retries, not the wake budget", () => {
    const { retry } = bootRetry(() => 0);
    expect(retry(2, serverError(500))).toBe(true);
    expect(retry(3, serverError(500))).toBe(false);
  });

  it("does not wait for a wake when the device is offline", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { retry } = bootRetry(() => 0);
    expect(retry(2, unreachable())).toBe(true);
    expect(retry(3, unreachable())).toBe(false);
  });

  it("waits at most 5 s between tries, so the app opens soon after the server is up", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { retryDelay } = bootRetry(() => 0);
    expect(retryDelay(0)).toBeLessThan(1_000);
    expect(retryDelay(10)).toBeLessThan(5_000);
    expect(retryDelay(10)).toBeGreaterThan(4_900);
  });
});
