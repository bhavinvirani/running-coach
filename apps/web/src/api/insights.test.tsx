import { ErrorCode, type InsightResponse } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { activityFixture, insightCardFixture, insightReadyFixture } from "@/test/fixtures";
import { holdPolls } from "@/test/held-polls";
import { testQueryClient } from "@/test/render";
import {
  INSIGHT_PENDING_POLL_MS,
  INSIGHT_RETRYING_POLL_MS,
  insightKey,
  useAskCoach,
  useInsight,
  useInsightFeedback,
} from "./insights";

const polls = holdPolls();

const run = activityFixture();
const card = insightCardFixture();

function wrapper() {
  const queryClient = testQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

const feedbackOf = (data: InsightResponse | undefined) =>
  data?.state === "ready" ? data.insight.feedback : undefined;

describe("useInsight", () => {
  it("reads the run's coach card under the insights' detail key", async () => {
    const calls = stubFetch(() => json(insightReadyFixture()));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useInsight(run.id), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(insightKey(run.id)).toEqual(["insights", "detail", run.id]);
    expect(calls[0]).toMatchObject({ method: "GET", path: `/api/activities/${run.id}/insight` });
    expect(queryClient.getQueryData(insightKey(run.id))).toEqual(insightReadyFixture());
    expect(polls.delays()).toEqual([]);
  });

  it("fails as not found for a malformed run id without asking the API", async () => {
    const calls = stubFetch(() => json({ state: "none" }));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useInsight("not-a-run"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toMatchObject({ code: "not_found" }));
    expect(calls).toEqual([]);
  });

  it("reads again every 3 s while the coach writes and stops once the card is ready (polling stops once ready)", async () => {
    let answer: InsightResponse = { state: "pending" };
    stubFetch(() => json(answer));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useInsight(run.id), { wrapper: Wrapper });

    await waitFor(() => expect(polls.delays()).toEqual([INSIGHT_PENDING_POLL_MS]));
    answer = insightReadyFixture();
    act(() => polls.fire());

    await waitFor(() => expect(result.current.data?.state).toBe("ready"));
    await waitFor(() => expect(polls.delays()).toEqual([]));
  });

  it("reads again every minute while Claude is down and the job will retry", async () => {
    stubFetch(() => json({ state: "retrying" }));
    const { Wrapper } = wrapper();
    renderHook(() => useInsight(run.id), { wrapper: Wrapper });

    await waitFor(() => expect(polls.delays()).toEqual([INSIGHT_RETRYING_POLL_MS]));
    expect(INSIGHT_RETRYING_POLL_MS).toBe(60_000);
  });

  it.each(["none", "no_key"] as const)("does not poll a run whose state is %s", async (state) => {
    stubFetch(() => json({ state }));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useInsight(run.id), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(polls.delays()).toEqual([]);
  });
});

describe("useAskCoach", () => {
  it("posts to the run's insight and caches the answer, so no read follows", async () => {
    const calls = stubFetch(({ method }) =>
      method === "POST" ? json({ state: "pending" }) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(insightKey(run.id), { state: "none" });
    const { result } = renderHook(() => useAskCoach(run.id), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: `/api/activities/${run.id}/insight` });
    expect(queryClient.getQueryData(insightKey(run.id))).toEqual({ state: "pending" });
  });

  it("fails with claude_key_missing when the key was removed and leaves the cached state", async () => {
    stubFetch(() => problem(409, ErrorCode.claudeKeyMissing));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(insightKey(run.id), { state: "none" });
    const { result } = renderHook(() => useAskCoach(run.id), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error).toMatchObject({ code: "claude_key_missing" }));
    expect(queryClient.getQueryData(insightKey(run.id))).toEqual({ state: "none" });
  });
});

describe("useInsightFeedback", () => {
  it("shows the thumb at once, puts it to the card's address and caches the answer", async () => {
    let answer!: (response: Response) => void;
    const calls = stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(insightKey(run.id), insightReadyFixture());
    const { result } = renderHook(() => useInsightFeedback(run.id), { wrapper: Wrapper });

    act(() => result.current.mutate({ insightId: card.id, feedback: "up" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(feedbackOf(queryClient.getQueryData(insightKey(run.id)))).toBe("up");
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/api/insights/${card.id}/feedback`,
      body: { feedback: "up" },
    });

    answer(json(insightReadyFixture(insightCardFixture({ feedback: "up" }))));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(insightKey(run.id))).toEqual(
      insightReadyFixture(insightCardFixture({ feedback: "up" })),
    );
  });

  it("sends null to clear a thumb", async () => {
    const calls = stubFetch(() => json(insightReadyFixture()));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(
      insightKey(run.id),
      insightReadyFixture(insightCardFixture({ feedback: "down" })),
    );
    const { result } = renderHook(() => useInsightFeedback(run.id), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync({ insightId: card.id, feedback: null }));

    expect(calls[0]?.body).toEqual({ feedback: null });
    expect(feedbackOf(queryClient.getQueryData(insightKey(run.id)))).toBeNull();
  });

  it("puts the earlier thumb back when the request fails (rollback)", async () => {
    stubFetch(() => problem(500, ErrorCode.internal));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(
      insightKey(run.id),
      insightReadyFixture(insightCardFixture({ feedback: "down" })),
    );
    const { result } = renderHook(() => useInsightFeedback(run.id), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ insightId: card.id, feedback: "up" }).catch(() => {});
    });

    expect(feedbackOf(queryClient.getQueryData(insightKey(run.id)))).toBe("down");
    await waitFor(() => expect(result.current.error).toMatchObject({ code: "internal" }));
  });

  it("sends quick taps one after another, in the order they were made", async () => {
    const answers: ((response: Response) => void)[] = [];
    const calls = stubFetch(() => new Promise<Response>((resolve) => answers.push(resolve)));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(insightKey(run.id), insightReadyFixture());
    const { result } = renderHook(() => useInsightFeedback(run.id), { wrapper: Wrapper });

    act(() => result.current.mutate({ insightId: card.id, feedback: "up" }));
    act(() => result.current.mutate({ insightId: card.id, feedback: "down" }));

    // The second tap shows at once but waits for the first request to finish before it is sent.
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(feedbackOf(queryClient.getQueryData(insightKey(run.id)))).toBe("down");
    answers[0]?.(json(insightReadyFixture(insightCardFixture({ feedback: "up" }))));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((call) => call.body)).toEqual([{ feedback: "up" }, { feedback: "down" }]);
    answers[1]?.(json(insightReadyFixture(insightCardFixture({ feedback: "down" }))));
    await waitFor(() =>
      expect(feedbackOf(queryClient.getQueryData(insightKey(run.id)))).toBe("down"),
    );
  });

  it("does not touch a run whose card is not loaded", async () => {
    stubFetch(never);
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useInsightFeedback(run.id), { wrapper: Wrapper });

    act(() => result.current.mutate({ insightId: card.id, feedback: "up" }));

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(queryClient.getQueryData(insightKey(run.id))).toBeUndefined();
  });
});
