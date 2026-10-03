import {
  ErrorCode,
  type CustomSessionInput,
  type SessionDetailResponse,
} from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, notFound, problem, stubFetch } from "@/test/fake-api";
import {
  customSessionFixture,
  garminPushStatusFixture,
  planSessionFixture,
  sessionDetailFixture,
} from "@/test/fixtures";
import { holdPolls } from "@/test/held-polls";
import { testQueryClient } from "@/test/render";
import { GARMIN_PUSH_POLL_MS, calendarKey } from "./calendar";
import { planKey } from "./plan";
import {
  sessionKey,
  useCreateSession,
  useMoveSession,
  useSession,
  useSkipSession,
  useUpdateSession,
} from "./sessions";

const polls = holdPolls();

const intervals = planSessionFixture("2026-10-08");

const input: CustomSessionInput = {
  date: "2026-10-09",
  type: "tempo",
  title: "Hill reps",
  steps: customSessionFixture().steps,
};

function wrapper() {
  const queryClient = testQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

/** The calendar and the plan as cached by Today and Plan, so a test can see them marked stale. */
function cacheViews(queryClient: ReturnType<typeof testQueryClient>) {
  queryClient.setQueryData(calendarKey("2026-10-08", "2026-10-14"), null);
  queryClient.setQueryData(planKey, { goal: null, plan: null });
  queryClient.setQueryData(sessionKey("another"), null);
}

function staleViews(queryClient: ReturnType<typeof testQueryClient>) {
  return [
    queryClient.getQueryState(calendarKey("2026-10-08", "2026-10-14"))?.isInvalidated,
    queryClient.getQueryState(planKey)?.isInvalidated,
    queryClient.getQueryState(sessionKey("another"))?.isInvalidated,
  ];
}

describe("useSession", () => {
  it("reads one session under the sessions' detail key", async () => {
    const calls = stubFetch(() => json(sessionDetailFixture()));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useSession(intervals.id), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sessionKey(intervals.id)).toEqual(["sessions", "detail", intervals.id]);
    expect(calls[0]?.path).toBe(`/api/sessions/${intervals.id}`);
    expect(queryClient.getQueryData(sessionKey(intervals.id))).toEqual(sessionDetailFixture());
  });

  it("reads again every 3 s while a push runs and stops when it ends", async () => {
    let detail = sessionDetailFixture({ garmin: garminPushStatusFixture({ pushing: true }) });
    stubFetch(() => json(detail));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useSession(intervals.id), { wrapper: Wrapper });

    await waitFor(() => expect(polls.delays()).toEqual([GARMIN_PUSH_POLL_MS]));
    detail = sessionDetailFixture({ session: { ...intervals, onGarmin: true } });
    act(() => polls.fire());

    await waitFor(() => expect(result.current.data?.session.onGarmin).toBe(true));
    await waitFor(() => expect(polls.delays()).toEqual([]));
  });
});

describe("useCreateSession", () => {
  it("posts the workout, caches the answer as its session and marks the calendar and plan stale", async () => {
    const created = sessionDetailFixture({ session: customSessionFixture() });
    const calls = stubFetch(({ method }) => (method === "POST" ? json(created) : notFound()));
    const { queryClient, Wrapper } = wrapper();
    cacheViews(queryClient);
    const { result } = renderHook(() => useCreateSession(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync(input));

    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/sessions", body: input });
    expect(queryClient.getQueryData(sessionKey(created.session.id))).toEqual(created);
    expect(staleViews(queryClient)).toEqual([true, true, true]);
    expect(queryClient.getQueryState(sessionKey(created.session.id))?.isInvalidated).toBe(false);
  });

  it("fails with plan_missing when the runner has no plan", async () => {
    stubFetch(() => problem(409, ErrorCode.planMissing));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useCreateSession(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync(input).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error).toMatchObject({ code: "plan_missing" }));
  });
});

describe("useUpdateSession", () => {
  it("puts the workout to its own address and caches the answer", async () => {
    const updated = sessionDetailFixture({
      session: customSessionFixture({ title: "Short hills" }),
    });
    const calls = stubFetch(({ method }) => (method === "PUT" ? json(updated) : notFound()));
    const { queryClient, Wrapper } = wrapper();
    const id = updated.session.id;
    const { result } = renderHook(() => useUpdateSession(id), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync({ ...input, title: "Short hills" }));

    expect(calls[0]).toMatchObject({ method: "PUT", path: `/api/sessions/${id}` });
    expect(queryClient.getQueryData<SessionDetailResponse>(sessionKey(id))?.session.title).toBe(
      "Short hills",
    );
  });
});

describe("useMoveSession", () => {
  it("sends the new date, caches the moved session without the warning and returns the warning", async () => {
    const warning = { code: "hard_days_close", otherType: "tempo", otherDate: "2026-10-10" };
    const moved = sessionDetailFixture({
      session: { ...intervals, date: "2026-10-09", status: "moved" },
    });
    const calls = stubFetch(({ method }) =>
      method === "POST" ? json({ ...moved, warning }) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    cacheViews(queryClient);
    const { result } = renderHook(() => useMoveSession(intervals.id), { wrapper: Wrapper });

    const answer = await act(() => result.current.mutateAsync("2026-10-09"));

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/sessions/${intervals.id}/move`,
      body: { date: "2026-10-09" },
    });
    expect(answer.warning).toEqual(warning);
    expect(queryClient.getQueryData(sessionKey(intervals.id))).toEqual(moved);
    expect(staleViews(queryClient)).toEqual([true, true, true]);
  });

  it("fails with session_locked for a session that can no longer move (missed or moved session)", async () => {
    stubFetch(() => problem(409, ErrorCode.sessionLocked));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useMoveSession(intervals.id), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync("2026-10-09").catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error).toMatchObject({ code: "session_locked" }));
  });
});

describe("useSkipSession", () => {
  it("deletes the session and caches it as skipped", async () => {
    const skipped = sessionDetailFixture({ session: { ...intervals, status: "skipped" } });
    const calls = stubFetch(({ method }) => (method === "DELETE" ? json(skipped) : notFound()));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useSkipSession(intervals.id), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync());

    expect(calls[0]).toMatchObject({ method: "DELETE", path: `/api/sessions/${intervals.id}` });
    expect(
      queryClient.getQueryData<SessionDetailResponse>(sessionKey(intervals.id))?.session.status,
    ).toBe("skipped");
  });
});
