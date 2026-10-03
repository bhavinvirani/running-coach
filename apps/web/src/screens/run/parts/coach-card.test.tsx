import type { CoachFeedback, InsightResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import {
  activityDetailFixture,
  activityFixture,
  activityResponseFixture,
  fallbackCardFixture,
  insightCardFixture,
  insightReadyFixture,
  meFixture,
} from "@/test/fixtures";
import { holdPolls } from "@/test/held-polls";
import { renderScreen } from "@/test/render";
import { RunScreen } from "../run-screen";

const polls = holdPolls();

const run = activityFixture();
const insightPath = `/api/activities/${run.id}/insight`;

type Answer = InsightResponse | (() => Response | Promise<Response>);

type FakeCoachApi = {
  /** What GET .../insight answers, in order; the last one repeats. */
  reads?: Answer[];
  /** What POST .../insight (Ask the coach, Try again) answers. */
  ask?: Answer;
  /** What PUT /api/insights/:id/feedback answers; by default the card with the thumb sent. */
  feedback?: (sent: CoachFeedback | null) => Response | Promise<Response>;
};

function answer(value: Answer): Response | Promise<Response> {
  return typeof value === "function" ? value() : json(value);
}

/** /api/me, the run with its detail already stored, and the coach's endpoints, in memory. */
function fakeCoachApi({
  reads = [{ state: "none" }],
  ask = { state: "pending" },
  feedback = (sent) => json(insightReadyFixture(insightCardFixture({ feedback: sent }))),
}: FakeCoachApi = {}) {
  let read = 0;
  return stubFetch(({ method, path, body }: FakeRequest) => {
    if (path === "/api/me") return json(meFixture());
    if (method === "GET" && path === insightPath) {
      const next = reads[Math.min(read, reads.length - 1)] as Answer;
      read += 1;
      return answer(next);
    }
    if (method === "POST" && path === insightPath) return answer(ask);
    if (method === "PUT" && path.endsWith("/feedback")) {
      return feedback((body as { feedback: CoachFeedback | null }).feedback);
    }
    if (method === "GET" && path === `/api/activities/${run.id}`) {
      return json(activityResponseFixture({ detail: activityDetailFixture() }));
    }
    return notFound();
  });
}

function renderRun() {
  return renderScreen(<RunScreen />, { route: "/runs/:id", path: `/runs/${run.id}` });
}

const coach = () => screen.getByRole("region", { name: "Coach" });
const findCoach = () => screen.findByRole("region", { name: "Coach" });
const asks = (calls: FakeRequest[]) =>
  calls.filter((call) => call.method === "POST" && call.path === insightPath);

describe("CoachCard", () => {
  beforeEach(() => {
    // jsdom has no layout; give the charts below a phone-width box to measure.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 358, height: 192 }),
    );
  });

  it("sits right under the run's stats, above the detail", async () => {
    fakeCoachApi({ reads: [insightReadyFixture()] });
    renderRun();
    await screen.findByRole("region", { name: "Route" });

    const sections = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));
    expect(sections.slice(0, 3)).toEqual(["Summary", "Coach", "Route"]);
    expect(within(coach()).getByRole("heading", { name: "Coach" })).toHaveClass("text-body");
  });

  it("shows skeleton lines in the card's final layout while loading, beside the loaded run", async () => {
    fakeCoachApi({ reads: [() => never()] });
    renderRun();

    const loading = await within(await findCoach()).findByRole("status", {
      name: "Loading the coach review",
    });
    expect(loading).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument();
    expect(within(coach()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry, while the rest of the run still shows", async () => {
    fakeCoachApi({ reads: [() => problem(500, ErrorCode.internal), insightReadyFixture()] });
    renderRun();

    const alert = await within(await findCoach()).findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Route" })).toBeInTheDocument();

    await userEvent.click(within(coach()).getByRole("button", { name: "Retry" }));

    expect(
      await within(coach()).findByText(insightCardFixture().content.headline),
    ).toBeInTheDocument();
    expect(within(coach()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks for the key with one sentence and one action when there is none (no key hides cards behind one action)", async () => {
    const calls = fakeCoachApi({ reads: [{ state: "no_key" }] });
    const { router } = renderRun();

    expect(
      await within(await findCoach()).findByText(
        "Add your Claude API key to get a coach review after each run.",
      ),
    ).toHaveClass("text-body", "text-ink-2");
    const link = within(coach()).getByRole("link", { name: "Add Claude key" });
    expect(link).toHaveAttribute("href", "/settings");
    expect(within(coach()).queryAllByRole("link")).toHaveLength(1);
    expect(within(coach()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(coach()).queryByRole("status")).not.toBeInTheDocument();
    expect(within(coach()).queryByRole("heading", { level: 3 })).not.toBeInTheDocument();

    await userEvent.click(link);
    expect(router.state.location.pathname).toBe("/settings");
    expect(asks(calls)).toEqual([]);
  });

  it("offers Ask the coach for a run without a card and shows the coach at work after it", async () => {
    const calls = fakeCoachApi({ reads: [{ state: "none" }], ask: { state: "pending" } });
    renderRun();

    expect(
      await within(await findCoach()).findByText("No coach review for this run yet."),
    ).toBeInTheDocument();
    await userEvent.click(within(coach()).getByRole("button", { name: "Ask the coach" }));

    const status = await within(coach()).findByRole("status");
    expect(status).toHaveTextContent("The coach is reviewing this run.");
    expect(asks(calls)).toHaveLength(1);
    expect(within(coach()).queryByRole("button")).not.toBeInTheDocument();
    // The answer went straight into the cache, and the poll for the card starts from it.
    expect(calls.filter((call) => call.path === insightPath && call.method === "GET")).toHaveLength(
      1,
    );
    await vi.waitFor(() => expect(polls.delays()).toEqual([3_000]));
  });

  it("shows the coach at work with skeleton lines while the card is pending, and the card once ready (polling stops once ready)", async () => {
    fakeCoachApi({ reads: [{ state: "pending" }, insightReadyFixture()] });
    renderRun();

    const status = await within(await findCoach()).findByRole("status");
    expect(status).toHaveTextContent(/^The coach is reviewing this run\.$/);
    expect(polls.delays()).toEqual([3_000]);

    act(() => polls.fire());

    expect(
      await within(coach()).findByText(insightCardFixture().content.headline),
    ).toBeInTheDocument();
    expect(within(coach()).queryByRole("status")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(polls.delays()).toEqual([]));
  });

  it('says "Coach unavailable, will retry" while retrying and reads again every minute', async () => {
    fakeCoachApi({ reads: [{ state: "retrying" }] });
    renderRun();

    const status = await within(await findCoach()).findByRole("status");
    expect(status).toHaveTextContent(/^Coach unavailable, will retry\.$/);
    expect(within(coach()).queryByRole("button")).not.toBeInTheDocument();
    expect(polls.delays()).toEqual([60_000]);
  });

  it("shows the model's card: the headline, what happened, what it means and next, with thumbs", async () => {
    fakeCoachApi({ reads: [insightReadyFixture()] });
    renderRun();
    const { content } = insightCardFixture();

    const headline = await within(await findCoach()).findByText(content.headline);
    expect(headline).toHaveClass("text-body", "font-semibold", "text-ink");
    const parts = within(coach()).getAllByRole("heading", { level: 3 });
    expect(parts.map((part) => part.textContent)).toEqual([
      "What happened",
      "What it means",
      "Next",
    ]);
    for (const part of parts) expect(part).toHaveClass("text-caption", "text-ink-2");
    expect(parts[0]?.nextElementSibling).toHaveTextContent(content.whatHappened);
    expect(parts[1]?.nextElementSibling).toHaveTextContent(content.whatItMeans);
    expect(parts[2]?.nextElementSibling).toHaveTextContent(content.nextStep);

    const helpful = within(coach()).getByRole("button", { name: "Helpful" });
    const notHelpful = within(coach()).getByRole("button", { name: "Not helpful" });
    expect(helpful).toHaveAttribute("aria-pressed", "false");
    expect(notHelpful).toHaveAttribute("aria-pressed", "false");
    expect(helpful).not.toHaveClass("text-accent");
    // No caution on a run that needs none, and nothing to try again.
    expect(within(coach()).queryByText(/Make the next run easy|Rest, and see/)).toBeNull();
    expect(within(coach()).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it.each([
    { caution: "easy_next", text: "Make the next run easy" },
    { caution: "rest_and_check", text: "Rest, and see a professional if it persists" },
  ] as const)("says the caution in words when it is $caution", async ({ caution, text }) => {
    const card = insightCardFixture({ content: { ...insightCardFixture().content, caution } });
    fakeCoachApi({ reads: [insightReadyFixture(card)] });
    renderRun();

    const line = await within(await findCoach()).findByText(text);
    expect(line).toHaveTextContent(new RegExp(`^${text}$`));
    expect(line).toHaveClass("text-body", "text-ink");
  });

  it("marks the thumb tapped, clears it on a second tap and sends each change", async () => {
    const calls = fakeCoachApi({ reads: [insightReadyFixture()] });
    renderRun();
    const helpful = await within(await findCoach()).findByRole("button", { name: "Helpful" });

    await userEvent.click(helpful);
    await vi.waitFor(() => expect(helpful).toHaveAttribute("aria-pressed", "true"));
    expect(helpful).toHaveClass("text-accent");
    expect(within(coach()).getByRole("button", { name: "Not helpful" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(helpful);
    await vi.waitFor(() => expect(helpful).toHaveAttribute("aria-pressed", "false"));

    const sent = calls.filter((call) => call.method === "PUT");
    expect(sent.map((call) => call.path)).toEqual([
      `/api/insights/${insightCardFixture().id}/feedback`,
      `/api/insights/${insightCardFixture().id}/feedback`,
    ]);
    expect(sent.map((call) => call.body)).toEqual([{ feedback: "up" }, { feedback: null }]);
  });

  it("puts the thumb back and says why when saving it fails (feedback rollback)", async () => {
    let fail!: () => void;
    fakeCoachApi({
      reads: [insightReadyFixture()],
      feedback: () =>
        new Promise<Response>(
          (resolve) => (fail = () => resolve(problem(500, ErrorCode.internal))),
        ),
    });
    renderRun();
    const notHelpful = await within(await findCoach()).findByRole("button", {
      name: "Not helpful",
    });

    await userEvent.click(notHelpful);
    // Shown at once, before the API answers.
    await vi.waitFor(() => expect(notHelpful).toHaveAttribute("aria-pressed", "true"));
    act(() => fail());

    await vi.waitFor(() => expect(notHelpful).toHaveAttribute("aria-pressed", "false"));
    expect(within(coach()).getByRole("alert")).toHaveTextContent(errorMessages.internal);
  });

  it.each(["refusal", "max_tokens"] as const)(
    "shows a fallback card's text without thumbs and with Try again (fallback card for refusal/max_tokens: %s)",
    async (reason) => {
      const fallback = fallbackCardFixture(reason);
      const calls = fakeCoachApi({
        reads: [insightReadyFixture(fallback)],
        ask: { state: "pending" },
      });
      renderRun();

      expect(
        await within(await findCoach()).findByText(fallback.content.headline),
      ).toBeInTheDocument();
      expect(within(coach()).getByText(fallback.content.whatHappened)).toBeInTheDocument();
      expect(within(coach()).getByText(fallback.content.nextStep)).toBeInTheDocument();
      expect(within(coach()).queryByRole("button", { name: "Helpful" })).not.toBeInTheDocument();
      expect(
        within(coach()).queryByRole("button", { name: "Not helpful" }),
      ).not.toBeInTheDocument();

      await userEvent.click(within(coach()).getByRole("button", { name: "Try again" }));

      expect(await within(coach()).findByRole("status")).toHaveTextContent(
        "The coach is reviewing this run.",
      );
      expect(asks(calls)).toHaveLength(1);
    },
  );

  it("shows a fallback card's reason as its own sentence between What happened and Next, without the What it means label", async () => {
    const fallback = fallbackCardFixture("unavailable");
    fakeCoachApi({ reads: [insightReadyFixture(fallback)] });
    renderRun();

    const reason = await within(await findCoach()).findByText(fallback.content.whatItMeans);
    expect(reason).toHaveClass("text-body", "text-ink");
    expect(within(coach()).queryByText("What it means")).not.toBeInTheDocument();
    const parts = within(coach()).getAllByRole("heading", { level: 3 });
    expect(parts.map((part) => part.textContent)).toEqual(["What happened", "Next"]);
    // In the coach's order: what happened, then why there is no review, then what to do.
    expect(parts[0]?.parentElement?.nextElementSibling).toBe(reason);
    expect(reason.nextElementSibling).toBe(parts[1]?.parentElement);
  });

  it.each(["invalid_output", "timeout", "unavailable", "request_rejected"] as const)(
    "offers Try again on a %s fallback card",
    async (reason) => {
      fakeCoachApi({ reads: [insightReadyFixture(fallbackCardFixture(reason))] });
      renderRun();

      expect(
        await within(await findCoach()).findByRole("button", { name: "Try again" }),
      ).toBeInTheDocument();
      expect(within(coach()).queryByRole("link")).not.toBeInTheDocument();
    },
  );

  it("offers Replace key, which opens Settings, and Try again on a card for a rejected key (rejected key card links to Settings)", async () => {
    const fallback = fallbackCardFixture("key_invalid");
    const calls = fakeCoachApi({ reads: [insightReadyFixture(fallback)] });
    const { router } = renderRun();

    expect(
      await within(await findCoach()).findByText(fallback.content.headline),
    ).toBeInTheDocument();
    const link = within(coach()).getByRole("link", { name: "Replace key" });
    expect(link).toHaveAttribute("href", "/settings");
    expect(within(coach()).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(within(coach()).queryByRole("button", { name: "Helpful" })).not.toBeInTheDocument();

    await userEvent.click(link);
    expect(router.state.location.pathname).toBe("/settings");
    expect(asks(calls)).toEqual([]);
  });

  it("asks the coach again from a card for a rejected key once the key is replaced (key_invalid Try again)", async () => {
    const calls = fakeCoachApi({
      reads: [insightReadyFixture(fallbackCardFixture("key_invalid"))],
      ask: { state: "pending" },
    });
    renderRun();

    await userEvent.click(
      await within(await findCoach()).findByRole("button", { name: "Try again" }),
    );

    expect(await within(coach()).findByRole("status")).toHaveTextContent(
      "The coach is reviewing this run.",
    );
    expect(asks(calls)).toHaveLength(1);
  });

  it("treats a card stored for a missing key like no key: Add Claude key", async () => {
    fakeCoachApi({ reads: [insightReadyFixture(fallbackCardFixture("missing_key"))] });
    renderRun();

    const link = await within(await findCoach()).findByRole("link", { name: "Add Claude key" });
    expect(link).toHaveAttribute("href", "/settings");
    expect(within(coach()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says why Ask the coach failed and keeps the button (our rate limit)", async () => {
    fakeCoachApi({
      reads: [{ state: "none" }],
      ask: () => problem(429, ErrorCode.rateLimited, { retryAfterSeconds: 60 }),
    });
    renderRun();

    await userEvent.click(
      await within(await findCoach()).findByRole("button", { name: "Ask the coach" }),
    );

    const alert = await within(coach()).findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.rate_limited);
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(within(coach()).getByRole("button", { name: "Ask the coach" })).toBeEnabled();
  });

  it("switches to the one Add Claude key action when Ask the coach finds the key removed on another device (409 claude_key_missing)", async () => {
    const calls = fakeCoachApi({
      reads: [{ state: "none" }, { state: "no_key" }],
      ask: () => problem(409, ErrorCode.claudeKeyMissing),
    });
    renderRun();

    await userEvent.click(
      await within(await findCoach()).findByRole("button", { name: "Ask the coach" }),
    );

    const link = await within(coach()).findByRole("link", { name: "Add Claude key" });
    expect(link).toHaveAttribute("href", "/settings");
    expect(within(coach()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(coach()).queryByRole("alert")).not.toBeInTheDocument();
    expect(asks(calls)).toHaveLength(1);
  });

  it("says why Try again failed on a fallback card", async () => {
    fakeCoachApi({
      reads: [insightReadyFixture(fallbackCardFixture("timeout"))],
      ask: () => problem(429, ErrorCode.rateLimited),
    });
    renderRun();

    await userEvent.click(
      await within(await findCoach()).findByRole("button", { name: "Try again" }),
    );

    expect(await within(coach()).findByRole("alert")).toHaveTextContent(errorMessages.rate_limited);
  });
});
