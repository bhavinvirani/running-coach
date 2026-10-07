import { ErrorCode } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, notFound, problem, stubFetch } from "@/test/fake-api";
import { calendarFixture, planResponseFixture, sessionDetailFixture } from "@/test/fixtures";
import {
  endPauseResponseFixture,
  pauseResponseFixture,
  trainingPauseFixture,
} from "@/test/fixtures-adaptation";
import { testQueryClient } from "@/test/render";
import { calendarKey } from "./calendar";
import { pauseKey, useEndPause, usePause, useStartPause } from "./pause";
import { planKey } from "./plan";
import { sessionKey } from "./sessions";

const FROM = "2026-10-08";
const TO = "2026-10-14";
const SESSION_ID = sessionDetailFixture().session.id;

function wrapper() {
  const queryClient = testQueryClient();
  // Every view of the sessions the pause changes, already read once.
  queryClient.setQueryData(calendarKey(FROM, TO), calendarFixture(FROM));
  queryClient.setQueryData(planKey, planResponseFixture());
  queryClient.setQueryData(sessionKey(SESSION_ID), sessionDetailFixture());
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

function stale(queryClient: ReturnType<typeof testQueryClient>) {
  return [calendarKey(FROM, TO), planKey, sessionKey(SESSION_ID)].map(
    (key) => queryClient.getQueryState(key)?.isInvalidated,
  );
}

describe("usePause", () => {
  it("reads the open pause under the pause detail key", async () => {
    stubFetch(({ method, path }) =>
      method === "GET" && path === "/api/pause" ? json(pauseResponseFixture()) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => usePause(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(pauseKey()).toEqual(["pause", "detail"]);
    expect(queryClient.getQueryData(pauseKey())).toEqual(pauseResponseFixture());
  });

  it("asks nothing until there is a plan to pause (no plan)", () => {
    const calls = stubFetch(() => json(pauseResponseFixture(null)));
    const { Wrapper } = wrapper();
    renderHook(() => usePause(false), { wrapper: Wrapper });

    expect(calls).toEqual([]);
  });
});

describe("useStartPause", () => {
  it("sends the reason, stores the open pause and reads every session view again", async () => {
    const calls = stubFetch(({ method, path }) => {
      if (method === "POST" && path === "/api/pause") {
        return json(pauseResponseFixture(trainingPauseFixture({ reason: "injured" })));
      }
      return notFound();
    });
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useStartPause(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync("injured"));

    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ reason: "injured" });
    expect(queryClient.getQueryData(pauseKey())).toEqual(
      pauseResponseFixture(trainingPauseFixture({ reason: "injured" })),
    );
    expect(stale(queryClient)).toEqual([true, true, true]);
  });

  it("leaves the cache as it was when the API refuses", async () => {
    stubFetch(() => problem(500, ErrorCode.internal));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(pauseKey(), pauseResponseFixture(null));
    const { result } = renderHook(() => useStartPause(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync("sick").catch(() => undefined));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(queryClient.getQueryData(pauseKey())).toEqual(pauseResponseFixture(null));
    expect(stale(queryClient)).toEqual([false, false, false]);
  });
});

describe("useEndPause", () => {
  it("closes the pause, keeps the re-entry as its data and reads every session view again", async () => {
    stubFetch(({ method, path }) =>
      method === "POST" && path === "/api/pause/end" ? json(endPauseResponseFixture()) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(pauseKey(), pauseResponseFixture());
    const { result } = renderHook(() => useEndPause(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync());

    expect(queryClient.getQueryData(pauseKey())).toEqual({ pause: null });
    await waitFor(() =>
      expect(result.current.data?.reEntry).toEqual(endPauseResponseFixture().reEntry),
    );
    expect(stale(queryClient)).toEqual([true, true, true]);
  });

  it("closes the pause on a second tap that finds none open (double I'm back)", async () => {
    stubFetch(() => json(endPauseResponseFixture(null)));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(pauseKey(), pauseResponseFixture());
    const { result } = renderHook(() => useEndPause(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync());

    expect(queryClient.getQueryData(pauseKey())).toEqual({ pause: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.reEntry).toBeNull();
  });
});
