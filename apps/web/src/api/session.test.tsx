import { ErrorCode } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, problem, stubFetch } from "@/test/fake-api";
import { meFixture, signInFixture } from "@/test/fixtures";
import { testQueryClient } from "@/test/render";
import { detailKey } from "./query-keys";
import { useLogIn, useLogOut } from "./session";

function renderSessionHook<T>(hook: () => T) {
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(hook, { wrapper }), queryClient };
}

describe("useLogIn", () => {
  it("keeps the problem's code, request id and retry hint when sign-in is rate limited", async () => {
    stubFetch(() =>
      problem(429, ErrorCode.rateLimited, { requestId: "req-login", retryAfterSeconds: 42 }),
    );
    const { result } = renderSessionHook(useLogIn);

    result.current.mutate({ email: "runner@example.com", password: "correct horse" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({
      status: 429,
      code: "rate_limited",
      requestId: "req-login",
      retryAfterSeconds: 42,
    });
  });

  it("takes the code from the API's problem, not a guess from the status", async () => {
    stubFetch(() => problem(403, ErrorCode.unauthorized, { detail: "Invalid origin" }));
    const { result } = renderSessionHook(useLogIn);

    result.current.mutate({ email: "runner@example.com", password: "correct horse" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({
      status: 403,
      code: "unauthorized",
      detail: "Invalid origin",
    });
  });

  it("drops what an earlier session cached once signed in", async () => {
    stubFetch(() => json(signInFixture()));
    const { result, queryClient } = renderSessionHook(useLogIn);
    queryClient.setQueryData(detailKey("me"), meFixture());

    result.current.mutate({ email: "runner@example.com", password: "correct horse" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(detailKey("me"))).toBeUndefined();
  });
});

describe("useLogOut", () => {
  it("posts to sign-out through the one fetch wrapper and clears the cache", async () => {
    const calls = stubFetch(() => json({ success: true }));
    const { result, queryClient } = renderSessionHook(useLogOut);
    queryClient.setQueryData(detailKey("me"), meFixture());

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/auth/sign-out", body: {} });
    expect(calls[0]?.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(queryClient.getQueryData(detailKey("me"))).toBeUndefined();
  });
});
