import { ErrorCode, type MeResponse } from "@running-coach/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import {
  FIXTURE_CODE,
  FIXTURE_EMAIL,
  FIXTURE_PASSWORD,
  codeNeededFixture,
  disconnectedFixture,
  garminConnectedFixture,
  syncedFixture,
} from "@/test/fixtures-garmin-login";
import { settle } from "@/test/lifecycle";
import { testQueryClient } from "@/test/render";
import { calendarKey } from "./calendar";
import { SentOnce, useDisconnectGarmin, useFinishGarminLogin, useStartGarminLogin } from "./garmin";
import { useGarminConnection } from "./me";
import { planKey } from "./plan";
import { actionKey, detailKey } from "./query-keys";
import { sessionKey } from "./sessions";
import { useForgetSyncOutcomeOnReconnect, useLatestSync, useSyncNow } from "./sync";

function meWithStatus(status: MeResponse["garmin"]["status"]): MeResponse {
  return meFixture({ garmin: { ...meFixture().garmin, status } });
}

type Handler = (request: FakeRequest) => Response | Promise<Response>;

/**
 * The Garmin hooks beside what the tab shell and Today run (the reconnect hook, Sync now, the latest sync),
 * with /api/me as the loader cached it and the views a push changes cached and fresh.
 */
function renderGarminHooks(handler: Handler, me: MeResponse = meWithStatus("expired")) {
  const calls = stubFetch(handler);
  const queryClient = testQueryClient();
  queryClient.setQueryData(detailKey("me"), me);
  const views = {
    calendar: calendarKey("2026-10-07", "2026-10-13"),
    plan: planKey,
    session: sessionKey("3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"),
  };
  for (const key of Object.values(views)) queryClient.setQueryData(key, {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      useForgetSyncOutcomeOnReconnect();
      return {
        start: useStartGarminLogin(),
        finish: useFinishGarminLogin(),
        disconnect: useDisconnectGarmin(),
        syncNow: useSyncNow(),
        latest: useLatestSync(),
        status: useGarminConnection().data?.status,
      };
    },
    { wrapper },
  );
  const invalidated = () =>
    Object.fromEntries(
      Object.entries(views).map(([name, key]) => [
        name,
        queryClient.getQueryState(key)?.isInvalidated ?? false,
      ]),
    );
  return { ...view, calls, queryClient, invalidated };
}

const status = (queryClient: QueryClient) =>
  queryClient.getQueryData<MeResponse>(detailKey("me"))?.garmin.status;
const syncs = (calls: FakeRequest[]) => calls.filter((call) => call.path === "/api/sync");
const credentials = () => new SentOnce({ email: FIXTURE_EMAIL, password: FIXTURE_PASSWORD });

describe("SentOnce", () => {
  it("gives its value once and holds nothing after", () => {
    const secret = new SentOnce({ mfaCode: FIXTURE_CODE });

    expect(secret.take()).toEqual({ mfaCode: FIXTURE_CODE });
    expect(() => secret.take()).toThrow();
    expect(JSON.stringify(secret)).not.toContain(FIXTURE_CODE);
  });
});

describe("useStartGarminLogin and useFinishGarminLogin", () => {
  it("change nothing and send no sync while Garmin waits for the code (2FA)", async () => {
    const { result, calls, queryClient, invalidated } = renderGarminHooks(({ path }) =>
      path === "/api/garmin/login" ? json(codeNeededFixture()) : json(meWithStatus("expired")),
    );

    await act(() => result.current.start.mutateAsync(credentials()));

    expect(status(queryClient)).toBe("expired");
    expect(syncs(calls)).toHaveLength(0);
    expect(invalidated()).toEqual({ calendar: false, plan: false, session: false });
  });

  it("show the login ok at once, send Sync now's own request, and read /api/me and every session view again once connected", async () => {
    let answerSync!: (response: Response) => void;
    const { result, calls, queryClient, invalidated } = renderGarminHooks(({ path }) => {
      if (path === "/api/garmin/login/code") return json(garminConnectedFixture());
      if (path === "/api/sync") return new Promise((resolve) => (answerSync = resolve));
      return json(meWithStatus("ok"));
    });

    await act(() => result.current.finish.mutateAsync(new SentOnce({ mfaCode: FIXTURE_CODE })));

    expect(status(queryClient)).toBe("ok");
    expect(invalidated()).toEqual({ calendar: true, plan: true, session: true });
    await waitFor(() => expect(syncs(calls)).toHaveLength(1));
    // Today reads it from the mutation cache, under Sync now's key.
    expect(queryClient.isMutating({ mutationKey: actionKey("sync") })).toBe(1);
    expect(result.current.latest.syncing).toBe(true);
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "/api/me").length).toBeGreaterThan(0),
    );
    act(() => answerSync(json(syncedFixture())));
    await waitFor(() => expect(result.current.latest.result).toEqual(syncedFixture()));
  });

  it("keeps the reconnect's sync outcome and drops the earlier sync's login error (token expiry, then reconnect)", async () => {
    let serverStatus: MeResponse["garmin"]["status"] = "ok";
    let answerSync!: (response: Response) => void;
    const { result } = renderGarminHooks(({ path }) => {
      if (path === "/api/garmin/login") {
        serverStatus = "ok";
        return json(garminConnectedFixture());
      }
      if (path === "/api/sync") {
        if (serverStatus !== "ok") return problem(409, ErrorCode.garminAuthExpired);
        return new Promise((resolve) => (answerSync = resolve));
      }
      return json(meWithStatus(serverStatus));
    }, meWithStatus("ok"));
    // Garmin expired the login since /api/me was cached: the sync fails and the API marks it.
    serverStatus = "expired";
    await act(() => result.current.syncNow.mutateAsync().catch(() => undefined));
    await waitFor(() => expect(result.current.status).toBe("expired"));
    expect(result.current.latest.error).toMatchObject({ code: ErrorCode.garminAuthExpired });

    await act(() => result.current.start.mutateAsync(credentials()));

    // The tab shell has seen the reconnect while the new sync runs, which a sync always outlasts: it
    // stays pending until the reads after it return.
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current.latest).toEqual({ syncing: true, error: null, result: undefined });
    act(() => answerSync(json(syncedFixture())));
    await waitFor(() => expect(result.current.latest.syncing).toBe(false));
    await settle();

    expect(result.current.latest).toEqual({ syncing: false, error: null, result: syncedFixture() });
  });

  it("send the password and the code but keep neither in the mutation cache", async () => {
    const { result, queryClient } = renderGarminHooks(({ path }) => {
      if (path === "/api/garmin/login") return json(codeNeededFixture());
      if (path === "/api/garmin/login/code") return json(garminConnectedFixture());
      if (path === "/api/sync") return json(syncedFixture());
      return json(meWithStatus("ok"));
    });

    await act(() => result.current.start.mutateAsync(credentials()));
    await act(() => result.current.finish.mutateAsync(new SentOnce({ mfaCode: FIXTURE_CODE })));

    const kept = JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    );
    expect(kept).not.toContain(FIXTURE_PASSWORD);
    expect(kept).not.toContain(FIXTURE_CODE);
  });
});

describe("useDisconnectGarmin", () => {
  it("shows not connected at once and reads /api/me and every session view again", async () => {
    const { result, calls, queryClient, invalidated } = renderGarminHooks(
      ({ path }) =>
        path === "/api/garmin/connection"
          ? json(disconnectedFixture(2))
          : json(meWithStatus("not_connected")),
      meWithStatus("ok"),
    );

    const answer = await act(() => result.current.disconnect.mutateAsync({ workouts: "remove" }));

    expect(answer).toEqual({ removedWorkouts: 2 });
    expect(status(queryClient)).toBe("not_connected");
    expect(invalidated()).toEqual({ calendar: true, plan: true, session: true });
    const sent = calls.find((call) => call.method === "DELETE");
    expect(sent?.path).toBe("/api/garmin/connection");
    expect(sent?.query.get("workouts")).toBe("remove");
  });

  it("keeps the status after a failure and reads /api/me again, which says whether Garmin expired the login", async () => {
    const { result, queryClient, invalidated } = renderGarminHooks(
      ({ path }) =>
        path === "/api/garmin/connection"
          ? problem(409, ErrorCode.garminAuthExpired)
          : json(meWithStatus("expired")),
      meWithStatus("ok"),
    );

    await act(() =>
      result.current.disconnect.mutateAsync({ workouts: "remove" }).catch(() => undefined),
    );

    expect(invalidated()).toEqual({ calendar: true, plan: true, session: true });
    await waitFor(() => expect(status(queryClient)).toBe("expired"));
  });
});
