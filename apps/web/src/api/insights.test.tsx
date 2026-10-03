import {
  ErrorCode,
  type CoachFeedback,
  type InsightFeedbackRequest,
  type InsightResponse,
} from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import {
  activityFixture,
  insightCardFixture,
  insightReadyFixture,
  meFixture,
} from "@/test/fixtures";
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
import { useSettings } from "./me";
import { detailKey } from "./query-keys";

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

  it("reads the run's card again when the key was removed on another device (409 claude_key_missing)", async () => {
    const calls = stubFetch(({ method }) =>
      method === "POST" ? problem(409, ErrorCode.claudeKeyMissing) : json({ state: "no_key" }),
    );
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(insightKey(run.id), { state: "none" });
    const { result } = renderHook(
      () => ({ insight: useInsight(run.id), ask: useAskCoach(run.id) }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.insight.data).toEqual({ state: "no_key" }));
    queryClient.setQueryData(insightKey(run.id), { state: "none" });
    const reads = () => calls.filter((call) => call.method === "GET").length;
    const readsBefore = reads();

    await act(async () => {
      await result.current.ask.mutateAsync().catch(() => undefined);
    });

    await waitFor(() =>
      expect(result.current.ask.error).toMatchObject({ code: "claude_key_missing" }),
    );
    await waitFor(() => expect(result.current.insight.data).toEqual({ state: "no_key" }));
    expect(reads()).toBe(readsBefore + 1);
  });

  it("reads /api/me again on 409 claude_key_missing, so Settings stops showing the removed key as Saved", async () => {
    const withKey = (hasClaudeKey: boolean) =>
      meFixture({ settings: { ...meFixture().settings, hasClaudeKey } });
    const calls = stubFetch(({ method, path }) => {
      if (path === "/api/me") return json(withKey(false));
      return method === "POST" ? problem(409, ErrorCode.claudeKeyMissing) : json({ state: "none" });
    });
    const { queryClient, Wrapper } = wrapper();
    // Cached a moment ago, when the key was still set: fresh for a minute, so nothing reads it again alone.
    queryClient.setQueryData(detailKey("me"), withKey(true));
    const { result } = renderHook(() => ({ settings: useSettings(), ask: useAskCoach(run.id) }), {
      wrapper: Wrapper,
    });
    expect(result.current.settings.data?.hasClaudeKey).toBe(true);

    await act(async () => {
      await result.current.ask.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.settings.data?.hasClaudeKey).toBe(false));
    expect(calls.filter((call) => call.path === "/api/me")).toHaveLength(1);
  });

  it("leaves /api/me alone when Ask the coach fails for another reason (429)", async () => {
    stubFetch(() => problem(429, ErrorCode.rateLimited));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(detailKey("me"), meFixture());
    const { result } = renderHook(() => useAskCoach(run.id), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error).toMatchObject({ code: "rate_limited" }));
    expect(queryClient.getQueryState(detailKey("me"))?.isInvalidated).toBe(false);
  });

  it("leaves the cached card as it is when Ask the coach is rate limited (429)", async () => {
    stubFetch(() => problem(429, ErrorCode.rateLimited));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(insightKey(run.id), { state: "none" });
    const { result } = renderHook(() => useAskCoach(run.id), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error).toMatchObject({ code: "rate_limited" }));
    expect(queryClient.getQueryData(insightKey(run.id))).toEqual({ state: "none" });
    expect(queryClient.getQueryState(insightKey(run.id))?.isInvalidated).toBe(false);
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

  it("puts the earlier thumb back and reads the card again when a lone tap fails (rollback)", async () => {
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
    expect(queryClient.getQueryState(insightKey(run.id))?.isInvalidated).toBe(true);
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

  describe("two quick taps (thumbs race)", () => {
    type Outcome = "saved" | "failed";

    /**
     * The card on the server, which keeps a thumb only when its PUT saves; each PUT waits until the test
     * settles it, and reads can be held too.
     */
    function fakeFeedbackServer() {
      let saved: CoachFeedback | null = null;
      const puts: ((outcome: Outcome) => void)[] = [];
      let holdReads = false;
      const heldReads: (() => void)[] = [];
      const read = () => json(insightReadyFixture(insightCardFixture({ feedback: saved })));
      const calls = stubFetch(({ method, body }) => {
        if (method === "PUT") {
          const sent = (body as InsightFeedbackRequest).feedback;
          return new Promise<Response>((resolve) =>
            puts.push((outcome) => {
              if (outcome === "failed") return resolve(problem(500, ErrorCode.internal));
              saved = sent;
              resolve(read());
            }),
          );
        }
        if (!holdReads) return read();
        return new Promise<Response>((resolve) => heldReads.push(() => resolve(read())));
      });
      return {
        calls,
        sent: () => calls.filter((call) => call.method === "PUT").length,
        reads: () => calls.filter((call) => call.method === "GET").length,
        settle: (index: number, outcome: Outcome) => puts[index]?.(outcome),
        holdReads: () => (holdReads = true),
        releaseReads: () => heldReads.splice(0).forEach((release) => release()),
      };
    }

    /** The card loaded and observed, as on the run screen, then thumbs up and down in quick succession. */
    async function tapUpThenDown() {
      const server = fakeFeedbackServer();
      const { queryClient, Wrapper } = wrapper();
      const { result } = renderHook(
        () => ({ insight: useInsight(run.id), feedback: useInsightFeedback(run.id) }),
        { wrapper: Wrapper },
      );
      await waitFor(() => expect(result.current.insight.isSuccess).toBe(true));
      const shown = () => feedbackOf(queryClient.getQueryData(insightKey(run.id)));

      act(() => result.current.feedback.mutate({ insightId: card.id, feedback: "up" }));
      act(() => result.current.feedback.mutate({ insightId: card.id, feedback: "down" }));
      await waitFor(() => expect(server.sent()).toBe(1));
      expect(shown()).toBe("down");
      return { server, queryClient, result, shown };
    }

    it("keeps the second tap on screen when the first one's answer lands, then shows the second's (both saved, no flicker)", async () => {
      const { server, shown, result } = await tapUpThenDown();

      act(() => server.settle(0, "saved"));
      await waitFor(() => expect(server.sent()).toBe(2));
      expect(shown()).toBe("down");

      act(() => server.settle(1, "saved"));
      await waitFor(() => expect(result.current.feedback.isSuccess).toBe(true));
      expect(shown()).toBe("down");
    });

    it("keeps the second tap on screen when the first fails, and takes its answer once it saves (first fails, second saves)", async () => {
      const { server, shown, result, queryClient } = await tapUpThenDown();

      act(() => server.settle(0, "failed"));
      await waitFor(() => expect(server.sent()).toBe(2));
      expect(shown()).toBe("down");

      act(() => server.settle(1, "saved"));
      await waitFor(() => expect(result.current.feedback.isSuccess).toBe(true));
      expect(shown()).toBe("down");
      expect(result.current.feedback.error).toBeNull();
      expect(queryClient.getQueryState(insightKey(run.id))?.isInvalidated).toBe(false);
    });

    it("reads the card again when the second fails after the first saved, and shows the saved thumb (first saves, second fails)", async () => {
      const { server, shown, result } = await tapUpThenDown();
      const readsBefore = server.reads();

      act(() => server.settle(0, "saved"));
      await waitFor(() => expect(server.sent()).toBe(2));
      expect(shown()).toBe("down");

      act(() => server.settle(1, "failed"));
      await waitFor(() =>
        expect(result.current.feedback.error).toMatchObject({ code: "internal" }),
      );
      await waitFor(() => expect(server.reads()).toBe(readsBefore + 1));
      await waitFor(() => expect(shown()).toBe("up"));
    });

    it("reads the card again when both fail instead of putting back the first tap, which was never saved (both fail)", async () => {
      const { server, shown, result } = await tapUpThenDown();
      const readsBefore = server.reads();
      server.holdReads();

      act(() => server.settle(0, "failed"));
      await waitFor(() => expect(server.sent()).toBe(2));
      expect(shown()).toBe("down");

      act(() => server.settle(1, "failed"));
      await waitFor(() =>
        expect(result.current.feedback.error).toMatchObject({ code: "internal" }),
      );
      await waitFor(() => expect(server.reads()).toBe(readsBefore + 1));
      // Until the server answers, the cache never holds the unsaved first tap.
      expect(shown()).not.toBe("up");

      act(() => server.releaseReads());
      await waitFor(() => expect(shown()).toBeNull());
    });
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
