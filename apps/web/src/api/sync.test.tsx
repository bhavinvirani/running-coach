import { ErrorCode, type MeResponse, type SyncResponse } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { json, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { testQueryClient } from "@/test/render";
import { meQueryOptions } from "./me";
import { planKey } from "./plan";
import { actionKey, detailKey, listKey } from "./query-keys";
import { sessionKey } from "./sessions";
import { useForgetSyncOutcomeOnReconnect, useLatestSync, useSyncNow } from "./sync";
import { settle } from "@/test/lifecycle";

/** Two screens' Sync now (say Today before and after a remount) and what any screen reads of the sync. */
function renderSyncHooks() {
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const useHooks = () => ({ first: useSyncNow(), second: useSyncNow(), latest: useLatestSync() });
  return { ...renderHook(useHooks, { wrapper }), queryClient };
}

function synced(activitiesWritten: number, activitiesRemoved = 0): Response {
  return json({
    lastSyncAt: "2026-09-28T07:40:00Z",
    activitiesWritten,
    activitiesRemoved,
  } satisfies SyncResponse);
}

/** Holds every POST /api/sync until the test answers it, in the order they were sent. */
function heldSyncs() {
  const answers: ((response: Response) => void)[] = [];
  const calls = stubFetch(() => new Promise<Response>((resolve) => answers.push(resolve)));
  return { calls, answer: (index: number, response: Response) => answers[index]?.(response) };
}

describe("useSyncNow", () => {
  it("queues a second Sync now behind the running one instead of sending both (overlapping syncs)", async () => {
    const { calls, answer } = heldSyncs();
    const { result } = renderSyncHooks();

    act(() => {
      result.current.first.mutate();
      result.current.second.mutate();
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(result.current.latest.syncing).toBe(true);

    act(() => answer(0, synced(1)));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(result.current.latest.syncing).toBe(true);

    act(() => answer(1, synced(0)));
    await waitFor(() => expect(result.current.latest.syncing).toBe(false));
    expect(result.current.latest).toEqual({
      syncing: false,
      error: null,
      result: { lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 0, activitiesRemoved: 0 },
    });
  });

  it("keeps the newest outcome after its screen is gone and drops older ones when a sync starts", async () => {
    const { calls, answer } = heldSyncs();
    const { result, queryClient } = renderSyncHooks();
    const syncs = () => queryClient.getMutationCache().findAll({ mutationKey: actionKey("sync") });

    act(() => result.current.first.mutate());
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => answer(0, synced(1)));
    await waitFor(() => expect(result.current.latest.result?.activitiesWritten).toBe(1));

    act(() => result.current.second.mutate());
    await waitFor(() => expect(calls).toHaveLength(2));

    expect(syncs()).toHaveLength(1);
    expect(result.current.latest).toEqual({ syncing: true, error: null, result: undefined });
  });
});

describe("useSyncNow refreshes", () => {
  /** What the screens hold before the sync: the plan, one session and the latest run, all fresh. */
  function cachedViews() {
    const queryClient = testQueryClient();
    const views = {
      plan: planKey,
      session: sessionKey("3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"),
      latest: detailKey("activities", "latest"),
      bests: listKey("personal-bests"),
    };
    for (const key of Object.values(views)) queryClient.setQueryData(key, {});
    const invalidated = () =>
      Object.fromEntries(
        Object.entries(views).map(([name, key]) => [
          name,
          queryClient.getQueryState(key)?.isInvalidated ?? false,
        ]),
      );
    return { queryClient, invalidated };
  }

  async function syncWith(answer: Response) {
    stubFetch(() => answer);
    const { queryClient, invalidated } = cachedViews();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSyncNow(), { wrapper });
    await act(() => result.current.mutateAsync());
    return invalidated();
  }

  it("the plan and its sessions as well as the runs and bests after a sync that removed runs deleted on Garmin (deleted activity)", async () => {
    expect(await syncWith(synced(0, 1))).toEqual({
      plan: true,
      session: true,
      latest: true,
      bests: true,
    });
  });

  it("the runs and bests but not the plan after a sync that removed none", async () => {
    expect(await syncWith(synced(1))).toEqual({
      plan: false,
      session: false,
      latest: true,
      bests: true,
    });
  });
});

function meWithStatus(status: MeResponse["garmin"]["status"]): MeResponse {
  return meFixture({ garmin: { ...meFixture().garmin, status } });
}

type ShellApi = {
  /** /api/me as the authenticated loader cached it before the shell mounted; none leaves the cache empty. */
  me?: MeResponse;
  /** What each POST /api/sync answers, by its number from 1; none holds it until `answer`. */
  sync?: (attempt: number) => Response;
};

/**
 * The tab shell's reconnect hook, with Sync now and what Today reads of the sync beside it, over a fake
 * GET /api/me and POST /api/sync.
 */
function renderShellHooks({ me, sync }: ShellApi = {}) {
  let serverMe = me ?? meWithStatus("ok");
  const held: ((response: Response) => void)[] = [];
  const calls = stubFetch(({ path }) => {
    if (path === "/api/me") return json(serverMe);
    if (sync) return sync(calls.filter((call) => call.path === "/api/sync").length);
    return new Promise<Response>((resolve) => held.push(resolve));
  });
  const queryClient = testQueryClient();
  if (me) queryClient.setQueryData(meQueryOptions().queryKey, me);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      useForgetSyncOutcomeOnReconnect();
      return { syncNow: useSyncNow(), latest: useLatestSync() };
    },
    { wrapper },
  );
  /** What GET /api/me answers from now on: the API marked the login, or the laptop reconnected it. */
  const serverSays = (next: MeResponse) => {
    serverMe = next;
  };
  /** A fresh GET /api/me, as useSyncOnOpen reads it back in the foreground. */
  const fetchMe = () => queryClient.fetchQuery({ ...meQueryOptions(), staleTime: 0 });
  /** /api/me read again with a new answer: a refetch after a sync, the foreground read, or Settings. */
  const readMe = (next: MeResponse) => {
    serverSays(next);
    return act(fetchMe);
  };
  return {
    ...view,
    queryClient,
    serverSays,
    fetchMe,
    readMe,
    syncs: () => calls.filter((call) => call.path === "/api/sync"),
    answer: (index: number, response: Response) => held[index]?.(response),
  };
}

describe("useForgetSyncOutcomeOnReconnect", () => {
  it.each([
    { corner: "reconnected", before: "expired" },
    { corner: "first connect", before: "not_connected" },
  ] as const)(
    "forgets an ended sync's error once /api/me's Garmin status moves from $before to ok ($corner)",
    async ({ before }) => {
      const { result, readMe, syncs, answer } = renderShellHooks({ me: meWithStatus("ok") });
      act(() => result.current.syncNow.mutate());
      await waitFor(() => expect(syncs()).toHaveLength(1));
      act(() => answer(0, problem(409, ErrorCode.garminAuthExpired)));
      await waitFor(() => expect(result.current.latest.error).not.toBeNull());

      await readMe(meWithStatus(before));
      await settle();
      expect(result.current.latest.error).not.toBeNull();
      await readMe(meWithStatus("ok"));

      await waitFor(() => expect(result.current.latest.error).toBeNull());
      expect(result.current.latest).toEqual({ syncing: false, error: null, result: undefined });
    },
  );

  it("keeps an ended sync's error when /api/me is read again still ok (first rejected login)", async () => {
    const { result, readMe, syncs, answer } = renderShellHooks({ me: meWithStatus("ok") });
    act(() => result.current.syncNow.mutate());
    await waitFor(() => expect(syncs()).toHaveLength(1));
    act(() => answer(0, problem(409, ErrorCode.garminAuthExpired)));
    await waitFor(() => expect(result.current.latest.error).not.toBeNull());

    await readMe(meWithStatus("ok"));
    await settle();

    expect(result.current.latest.error).toMatchObject({ code: ErrorCode.garminAuthExpired });
  });

  it("takes the first status it sees for a start, not a reconnect (page load)", async () => {
    const { result, readMe, syncs, answer } = renderShellHooks();
    act(() => result.current.syncNow.mutate());
    await waitFor(() => expect(syncs()).toHaveLength(1));
    act(() => answer(0, problem(502, ErrorCode.garminUnavailable)));
    await waitFor(() => expect(result.current.latest.error).not.toBeNull());

    await readMe(meWithStatus("ok"));
    await settle();

    expect(result.current.latest.error).toMatchObject({ code: ErrorCode.garminUnavailable });
  });

  it("removes nothing while a sync runs when the status moves to ok, and keeps that sync's outcome (sync pending)", async () => {
    const { result, queryClient, readMe, syncs, answer } = renderShellHooks({
      me: meWithStatus("expired"),
    });
    act(() => result.current.syncNow.mutate());
    await waitFor(() => expect(syncs()).toHaveLength(1));

    await readMe(meWithStatus("ok"));
    await settle();

    expect(queryClient.getMutationCache().findAll({ mutationKey: actionKey("sync") })).toHaveLength(
      1,
    );
    expect(result.current.latest.syncing).toBe(true);
    act(() => answer(0, synced(0)));
    await waitFor(() => expect(result.current.latest.result?.activitiesWritten).toBe(0));
  });

  it("keeps the outcome of the sync that the reconnect's foreground read starts (foreground sync after a reconnect)", async () => {
    const { result, queryClient, serverSays, fetchMe, readMe } = renderShellHooks({
      me: meWithStatus("ok"),
      sync: (attempt) => (attempt === 1 ? problem(409, ErrorCode.garminAuthExpired) : synced(1)),
    });
    act(() => result.current.syncNow.mutate());
    await waitFor(() => expect(result.current.latest.error).not.toBeNull());
    await readMe(meWithStatus("expired"));
    serverSays(meWithStatus("ok"));

    // As useSyncOnOpen does back in the foreground: the fresh /api/me says ok, and the sync goes out at once.
    await act(async () => {
      await fetchMe();
      result.current.syncNow.mutate();
      await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    });
    await settle();

    expect(result.current.latest).toEqual({
      syncing: false,
      error: null,
      result: { lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 1, activitiesRemoved: 0 },
    });
  });
});
