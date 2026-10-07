import { ErrorCode, type MeResponse, type SyncResponse } from "@running-coach/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { testQueryClient } from "@/test/render";
import { meQueryOptions } from "./me";
import { latestReviewKey } from "./reviews";
import { useLatestSync, useSyncNow } from "./sync";
import { SYNC_ON_OPEN_INTERVAL_MS, useSyncOnOpen } from "./sync-on-open";
import { backgroundAndReturn, settle } from "@/test/lifecycle";

const MINUTE = 60_000;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE).toISOString();
}

/** Moves the device clock on; only Date is faked, so TanStack Query and waitFor keep real timers. */
function laterBy(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

function meWith(garmin: Partial<MeResponse["garmin"]>): MeResponse {
  return meFixture({ garmin: { ...meFixture().garmin, ...garmin } });
}

type Server = {
  /** What GET /api/me answers: the runner, or a failure. */
  me: MeResponse | (() => Response | Promise<Response>);
  /** What POST /api/sync answers; by default a sync that moves lastSyncAt to now, like the API. */
  sync?: () => Response | Promise<Response>;
};

/** GET /api/me and POST /api/sync, changeable mid-test as the cron or another device would change them. */
function fakeServer(initial: Server) {
  const server = initial;
  const syncNow = (): Response => {
    const lastSyncAt = new Date().toISOString();
    if (typeof server.me !== "function")
      server.me = { ...server.me, garmin: { status: "ok", lastSyncAt } };
    return json({ lastSyncAt, activitiesWritten: 1, activitiesRemoved: 0 } satisfies SyncResponse);
  };
  const calls = stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/me") {
      return typeof server.me === "function" ? server.me() : json(server.me);
    }
    if (method === "POST" && path === "/api/sync") return (server.sync ?? syncNow)();
    return notFound();
  });
  return {
    server,
    calls,
    syncs: () => calls.filter((call) => call.method === "POST" && call.path === "/api/sync"),
    meReads: () => calls.filter((call) => call.path === "/api/me"),
  };
}

type OpenApp = {
  /** /api/me as the authenticated loader cached it just before the tab shell mounted. */
  me: MeResponse;
  /** The page's QueryClient: pass the earlier one to remount the shell, leave it out to reload the page. */
  queryClient?: QueryClient;
  strict?: boolean;
};

/** Mounts the tab shell's hook, with Sync now and the sync's state beside it as Today would read them. */
function openApp({ me, queryClient = testQueryClient(), strict = false }: OpenApp) {
  queryClient.setQueryData(meQueryOptions().queryKey, me);
  const wrapper = ({ children }: { children: ReactNode }) => {
    const tree = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  const view = renderHook(
    () => {
      useSyncOnOpen();
      return { syncNow: useSyncNow(), latest: useLatestSync() };
    },
    { wrapper },
  );
  return { ...view, queryClient };
}

describe("useSyncOnOpen", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T08:00:00Z"));
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs on open, with no body and no extra /api/me, when Garmin works and the last sync is 10 minutes old", async () => {
    const api = fakeServer({ me: meWith({ status: "ok", lastSyncAt: minutesAgo(10) }) });
    const { result } = openApp({ me: meWith({ status: "ok", lastSyncAt: minutesAgo(10) }) });

    await waitFor(() => expect(result.current.latest.result?.activitiesWritten).toBe(1));
    expect(api.calls).toEqual([
      expect.objectContaining({ method: "POST", path: "/api/sync", body: undefined }),
    ]);
  });

  it("reads Today's weekly review again after the sync on open, which queues the review of a week that has ended (weekly review queued)", async () => {
    fakeServer({ me: meWith({ status: "ok", lastSyncAt: minutesAgo(10) }) });
    const queryClient = testQueryClient();
    queryClient.setQueryData(latestReviewKey, { state: "none" });
    const { result } = openApp({
      me: meWith({ status: "ok", lastSyncAt: minutesAgo(10) }),
      queryClient,
    });

    await waitFor(() => expect(result.current.latest.result?.activitiesWritten).toBe(1));
    expect(queryClient.getQueryState(latestReviewKey)?.isInvalidated).toBe(true);
  });

  it("syncs on open when Garmin works and has never synced", async () => {
    const api = fakeServer({ me: meWith({ status: "ok", lastSyncAt: null }) });
    openApp({ me: meWith({ status: "ok", lastSyncAt: null }) });

    await waitFor(() => expect(api.syncs()).toHaveLength(1));
  });

  it("does not sync on open when the last sync is under 10 minutes old", async () => {
    const me = meWith({
      status: "ok",
      lastSyncAt: new Date(Date.now() - 10 * MINUTE + 1_000).toISOString(),
    });
    const api = fakeServer({ me });
    openApp({ me });

    await settle();
    expect(api.calls).toEqual([]);
  });

  it.each([
    { status: "expired", lastSyncAt: "2026-09-20T06:00:00Z" },
    { status: "not_connected", lastSyncAt: null },
  ] as const)(
    "does not sync on open or in the foreground when the Garmin login is $status",
    async ({ status, lastSyncAt }) => {
      const api = fakeServer({ me: meWith({ status, lastSyncAt }) });
      openApp({ me: meWith({ status, lastSyncAt }) });
      await settle();

      laterBy(30 * MINUTE);
      backgroundAndReturn();
      await waitFor(() => expect(api.meReads()).toHaveLength(1));
      await settle();

      expect(api.syncs()).toEqual([]);
    },
  );

  it("does not sync twice within 10 minutes of an attempt, also across a reload mid-sync", async () => {
    // The API is still syncing, so its lastSyncAt stays old: only this device's attempt holds the next one off.
    const api = fakeServer({ me: meWith({ lastSyncAt: minutesAgo(60) }), sync: never });
    const first = openApp({ me: meWith({ lastSyncAt: minutesAgo(60) }) });
    await waitFor(() => expect(api.syncs()).toHaveLength(1));

    first.unmount();
    laterBy(1 * MINUTE);
    const reloaded = openApp({ me: meWith({ lastSyncAt: minutesAgo(61) }) });
    await settle();
    expect(api.syncs()).toHaveLength(1);

    reloaded.unmount();

    laterBy(9 * MINUTE);
    openApp({ me: meWith({ lastSyncAt: minutesAgo(70) }) });
    await waitFor(() => expect(api.syncs()).toHaveLength(2));
  });

  it("sends one sync under StrictMode's double effects", async () => {
    const api = fakeServer({ me: meWith({ lastSyncAt: minutesAgo(60) }) });
    openApp({ me: meWith({ lastSyncAt: minutesAgo(60) }), strict: true });

    await waitFor(() => expect(api.syncs()).toHaveLength(1));
    await settle();
    expect(api.syncs()).toHaveLength(1);
  });

  it("syncs again on return to the foreground after 10 minutes, asking /api/me first", async () => {
    const api = fakeServer({ me: meWith({ lastSyncAt: minutesAgo(60) }) });
    const { result } = openApp({ me: meWith({ lastSyncAt: minutesAgo(60) }) });
    await waitFor(() => expect(result.current.latest.result).toBeDefined());
    const afterOpen = api.calls.length;

    laterBy(10 * MINUTE);
    backgroundAndReturn();

    await waitFor(() => expect(api.syncs()).toHaveLength(2));
    expect(api.calls.slice(afterOpen)).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/me" }),
      expect.objectContaining({ method: "POST", path: "/api/sync" }),
    ]);
  });

  it("skips the foreground sync when the fresh /api/me shows a sync under 10 minutes old (cron or another device)", async () => {
    const api = fakeServer({ me: meWith({ lastSyncAt: minutesAgo(5) }) });
    openApp({ me: meWith({ lastSyncAt: minutesAgo(5) }) });
    await settle();

    // The cached me now says 25 minutes, which alone would sync; the server knows of a sync 2 minutes ago.
    laterBy(20 * MINUTE);
    api.server.me = meWith({ lastSyncAt: minutesAgo(2) });
    backgroundAndReturn();
    await waitFor(() => expect(api.meReads()).toHaveLength(1));
    await settle();

    expect(api.syncs()).toEqual([]);
  });

  it("syncs in the foreground once the fresh /api/me shows the login working again (reconnected from the laptop)", async () => {
    const api = fakeServer({ me: meWith({ status: "expired", lastSyncAt: minutesAgo(60) }) });
    openApp({ me: meWith({ status: "expired", lastSyncAt: minutesAgo(60) }) });
    await settle();
    expect(api.syncs()).toEqual([]);

    laterBy(5 * MINUTE);
    api.server.me = meWith({ status: "ok", lastSyncAt: minutesAgo(65) });
    backgroundAndReturn();

    await waitFor(() => expect(api.syncs()).toHaveLength(1));
  });

  it("reads /api/me on return to the foreground with an expired login and a recent attempt, and sends no sync within the 10 minutes (reconnected from the laptop)", async () => {
    const api = fakeServer({
      me: meWith({ status: "ok", lastSyncAt: minutesAgo(60) }),
      sync: () => problem(409, ErrorCode.garminAuthExpired),
    });
    const { result, queryClient } = openApp({
      me: meWith({ status: "ok", lastSyncAt: minutesAgo(60) }),
    });
    await waitFor(() => expect(result.current.latest.error).not.toBeNull());
    // The API marked the login expired, and Today's /api/me observers read it once the sync settled.
    api.server.me = meWith({ status: "expired", lastSyncAt: minutesAgo(60) });
    await act(() => queryClient.fetchQuery({ ...meQueryOptions(), staleTime: 0 }));
    const afterExpired = api.calls.length;

    laterBy(5 * MINUTE);
    api.server.me = meWith({ status: "ok", lastSyncAt: minutesAgo(65) });
    backgroundAndReturn();
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(afterExpired));
    await settle();

    expect(api.calls.slice(afterExpired)).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/me" }),
    ]);
    expect(queryClient.getQueryData(meQueryOptions().queryKey)?.garmin.status).toBe("ok");
    expect(api.syncs()).toHaveLength(1);
  });

  it("skips the foreground sync when /api/me fails (session expired)", async () => {
    const api = fakeServer({ me: meWith({ lastSyncAt: minutesAgo(5) }) });
    openApp({ me: meWith({ lastSyncAt: minutesAgo(5) }) });
    await settle();

    laterBy(30 * MINUTE);
    api.server.me = () => problem(401, ErrorCode.unauthorized);
    backgroundAndReturn();
    await waitFor(() => expect(api.meReads()).toHaveLength(1));
    await settle();

    expect(api.syncs()).toEqual([]);
  });

  it("does not sync on open or in the foreground while a sync is running (Sync now still running)", async () => {
    let answerSync!: (response: Response) => void;
    const api = fakeServer({
      me: meWith({ lastSyncAt: minutesAgo(5) }),
      sync: () => new Promise<Response>((resolve) => (answerSync = resolve)),
    });
    const first = openApp({ me: meWith({ lastSyncAt: minutesAgo(5) }) });
    await settle();
    act(() => first.result.current.syncNow.mutate());
    await waitFor(() => expect(api.syncs()).toHaveLength(1));

    laterBy(20 * MINUTE);
    api.server.me = meWith({ lastSyncAt: minutesAgo(25) });
    backgroundAndReturn();
    await settle();
    // The shell remounts in the same page (log out and in) while the sync it started still runs.
    first.unmount();
    const second = openApp({
      me: meWith({ lastSyncAt: minutesAgo(25) }),
      queryClient: first.queryClient,
    });
    await settle();

    // A sync started now would queue behind the running one and go out once it ends: none does.
    act(() =>
      answerSync(
        json({
          lastSyncAt: minutesAgo(0),
          activitiesWritten: 0,
          activitiesRemoved: 0,
        } satisfies SyncResponse),
      ),
    );
    await waitFor(() => expect(second.result.current.latest.result).toBeDefined());
    await settle();
    expect(api.syncs()).toHaveLength(1);
    expect(second.result.current.latest.syncing).toBe(false);
  });

  it.each([
    { corner: "Garmin outage", answer: () => problem(502, ErrorCode.garminUnavailable) },
    {
      corner: "Garmin 429",
      answer: () => problem(429, ErrorCode.garminRateLimited, { retryAfterSeconds: 3600 }),
    },
  ])(
    "counts a failed sync as the attempt and does not retry it within 10 minutes ($corner)",
    async ({ answer }) => {
      const api = fakeServer({ me: meWith({ lastSyncAt: minutesAgo(60) }), sync: answer });
      const { result } = openApp({ me: meWith({ lastSyncAt: minutesAgo(60) }) });
      await waitFor(() => expect(result.current.latest.error).not.toBeNull());

      laterBy(SYNC_ON_OPEN_INTERVAL_MS - 1_000);
      backgroundAndReturn();
      await settle();
      // Nothing at all: within the interval of an attempt it does not even ask /api/me.
      expect(api.calls).toHaveLength(1);

      laterBy(1_000);
      backgroundAndReturn();
      await waitFor(() => expect(api.syncs()).toHaveLength(2));
    },
  );

  it.each([
    {
      storage: "throws (blocked)",
      block: () => {
        const blocked = () => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        };
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
      },
    },
    { storage: "is missing", block: () => vi.stubGlobal("localStorage", undefined) },
  ])("keeps the attempt in memory for the page when localStorage $storage", async ({ block }) => {
    block();
    const api = fakeServer({
      me: meWith({ lastSyncAt: minutesAgo(60) }),
      sync: () => problem(502, ErrorCode.garminUnavailable),
    });
    const { result } = openApp({ me: meWith({ lastSyncAt: minutesAgo(60) }) });
    await waitFor(() => expect(result.current.latest.error).not.toBeNull());

    laterBy(5 * MINUTE);
    backgroundAndReturn();
    await settle();
    expect(api.syncs()).toHaveLength(1);

    laterBy(5 * MINUTE);
    backgroundAndReturn();
    await waitFor(() => expect(api.syncs()).toHaveLength(2));
  });

  it("drops a foreground decision still waiting on /api/me and stops listening once the shell unmounts (log out)", async () => {
    let answerMe!: (response: Response) => void;
    const api = fakeServer({ me: meWith({ lastSyncAt: minutesAgo(5) }) });
    const { unmount } = openApp({ me: meWith({ lastSyncAt: minutesAgo(5) }) });
    await settle();

    laterBy(30 * MINUTE);
    api.server.me = () => new Promise<Response>((resolve) => (answerMe = resolve));
    backgroundAndReturn();
    await waitFor(() => expect(api.meReads()).toHaveLength(1));
    unmount();
    answerMe(json(meWith({ lastSyncAt: minutesAgo(35) })));
    await settle();
    expect(api.syncs()).toEqual([]);

    laterBy(30 * MINUTE);
    backgroundAndReturn();
    await settle();
    expect(api.calls).toHaveLength(1);
  });
});
