import { ErrorCode, type ImportProgress, type ImportStatus } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, notFound, stubFetch } from "@/test/fake-api";
import { importProgressFixture } from "@/test/fixtures";
import { holdPolls } from "@/test/held-polls";
import { testQueryClient } from "@/test/render";
import { useActivityWeeks } from "./activities";
import { useImportProgress, useStartImport } from "./import";
import { detailKey } from "./query-keys";

const polls = holdPolls();

function importAt(status: ImportStatus, runsStored: number): ImportProgress {
  return importProgressFixture({
    status,
    runsStored,
    oldestDate: runsStored > 0 ? "2024-03-14" : null,
    startedAt: status === "not_started" ? null : "2026-10-02T06:00:00Z",
    finishedAt: status === "done" ? "2026-10-02T06:52:00Z" : null,
    resumeAt: status === "paused" ? "2026-10-02T07:05:00Z" : null,
    errorCode:
      status === "paused"
        ? ErrorCode.garminRateLimited
        : status === "failed"
          ? ErrorCode.garminUnavailable
          : null,
  });
}

/** GET /api/import answers whatever `api.progress` holds; POST starts or resumes it; no runs listed. */
function fakeImportApi(initial: ImportProgress) {
  const api = { progress: initial };
  const calls = stubFetch(({ method, path }) => {
    if (path === "/api/import" && method === "GET") return json(api.progress);
    if (path === "/api/import" && method === "POST") {
      api.progress = importAt("running", api.progress.runsStored);
      return json(api.progress);
    }
    if (path === "/api/activities" && method === "GET") {
      return json({ weeks: [], nextBefore: null });
    }
    return notFound();
  });
  const count = (method: string, path: string) =>
    calls.filter((call) => call.method === method && call.path === path).length;
  return { api, count };
}

/** The import as Progress reads it, beside the weekly list it keeps fresh. */
function renderImportHooks() {
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const useHooks = () => ({
    progress: useImportProgress(),
    weeks: useActivityWeeks(),
    start: useStartImport(),
  });
  return { ...renderHook(useHooks, { wrapper }), queryClient };
}

describe("useImportProgress", () => {
  it("polls every 3 s while the import runs, every minute while paused, and stops when done", async () => {
    const { api, count } = fakeImportApi(importAt("running", 10));
    const { result } = renderImportHooks();
    await waitFor(() => expect(result.current.progress.data?.status).toBe("running"));
    expect(polls.delays()).toEqual([3_000]);

    api.progress = importAt("paused", 10);
    act(() => polls.fire());
    await waitFor(() => expect(result.current.progress.data?.status).toBe("paused"));
    expect(polls.delays()).toEqual([60_000]);

    api.progress = importAt("done", 10);
    act(() => polls.fire());
    await waitFor(() => expect(result.current.progress.data?.status).toBe("done"));
    expect(polls.delays()).toEqual([]);
    expect(count("GET", "/api/import")).toBe(3);
  });

  it.each(["not_started", "stalled", "failed"] as const)(
    "does not poll an import that is %s, since nothing moves until the runner acts",
    async (status) => {
      fakeImportApi(importAt(status, 0));
      const { result } = renderImportHooks();
      await waitFor(() => expect(result.current.progress.data?.status).toBe(status));
      expect(polls.delays()).toEqual([]);
    },
  );

  it("refreshes the runs, Today's latest among them, only when a poll finds more runs stored", async () => {
    const { api, count } = fakeImportApi(importAt("running", 10));
    const { result, queryClient } = renderImportHooks();
    queryClient.setQueryData(detailKey("activities", "latest"), { activity: null });
    await waitFor(() => expect(result.current.weeks.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.progress.isSuccess).toBe(true));
    expect(count("GET", "/api/activities")).toBe(1);

    // Same count: the page had nothing new, so the list stays as it is.
    act(() => polls.fire());
    await waitFor(() => expect(count("GET", "/api/import")).toBe(2));
    await waitFor(() => expect(result.current.progress.isFetching).toBe(false));
    expect(count("GET", "/api/activities")).toBe(1);
    expect(queryClient.getQueryState(detailKey("activities", "latest"))?.isInvalidated).toBe(false);

    api.progress = importAt("running", 25);
    act(() => polls.fire());

    await waitFor(() => expect(result.current.progress.data?.runsStored).toBe(25));
    await waitFor(() => expect(count("GET", "/api/activities")).toBe(2));
    expect(queryClient.getQueryState(detailKey("activities", "latest"))?.isInvalidated).toBe(true);
  });

  it("refreshes the runs when the import finishes, even when its last page stored none", async () => {
    const { api, count } = fakeImportApi(importAt("running", 25));
    const { result } = renderImportHooks();
    await waitFor(() => expect(result.current.weeks.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.progress.isSuccess).toBe(true));

    api.progress = importAt("done", 25);
    act(() => polls.fire());

    await waitFor(() => expect(result.current.progress.data?.status).toBe("done"));
    await waitFor(() => expect(count("GET", "/api/activities")).toBe(2));
  });
});

describe("useStartImport", () => {
  it("puts the progress POST /api/import answers in the cache and polls from it, with no second GET", async () => {
    const { count } = fakeImportApi(importAt("not_started", 0));
    const { result } = renderImportHooks();
    await waitFor(() => expect(result.current.progress.data?.status).toBe("not_started"));
    expect(polls.delays()).toEqual([]);

    act(() => result.current.start.mutate());

    await waitFor(() => expect(result.current.progress.data?.status).toBe("running"));
    expect(polls.delays()).toEqual([3_000]);
    expect(count("POST", "/api/import")).toBe(1);
    expect(count("GET", "/api/import")).toBe(1);
  });
});
