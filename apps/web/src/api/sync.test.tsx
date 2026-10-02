import type { SyncResponse } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, stubFetch } from "@/test/fake-api";
import { testQueryClient } from "@/test/render";
import { actionKey } from "./query-keys";
import { useLatestSync, useSyncNow } from "./sync";

/** Two screens' Sync now (say Today before and after a remount) and what any screen reads of the sync. */
function renderSyncHooks() {
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const useHooks = () => ({ first: useSyncNow(), second: useSyncNow(), latest: useLatestSync() });
  return { ...renderHook(useHooks, { wrapper }), queryClient };
}

function synced(activitiesWritten: number): Response {
  return json({ lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten } satisfies SyncResponse);
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
      result: { lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 0 },
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
