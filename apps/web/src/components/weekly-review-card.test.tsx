import type { CoachFeedback, Units, WeeklyReviewCard as Review } from "@running-coach/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { planSessionId } from "@/test/fixtures";
import {
  REVIEW_ID,
  fallbackReviewFixture,
  reviewChangeFixture,
  weeklyReviewCardFixture,
} from "@/test/fixtures-weekly-review";
import { renderScreen } from "@/test/render";
import { WeeklyReviewCard } from "./weekly-review-card";

type Options = {
  units?: Units;
  today?: string;
  comingWeek?: boolean;
  setFeedback?: (reviewId: string, feedback: CoachFeedback | null) => void;
  feedbackError?: Error | null;
};

/** The card inside a router, as Today and the review screen render it; today is Wed 14 Oct 2026. */
function renderCard(review: Review = weeklyReviewCardFixture(), options: Options = {}) {
  const {
    units = "km",
    today = "2026-10-14",
    comingWeek = false,
    setFeedback = () => {},
    feedbackError = null,
  } = options;
  return renderScreen(
    <WeeklyReviewCard
      review={review}
      units={units}
      today={today}
      setFeedback={setFeedback}
      feedbackError={feedbackError}
      comingWeek={comingWeek}
    />,
  );
}

/** A Stat: the label and its figure are siblings, so their parent reads "Time3:04:12". */
function stat(label: string) {
  return screen.getByText(label, { selector: "span" }).parentElement;
}

describe("WeeklyReviewCard", () => {
  it("shows the week's dates, the headline, distance, sessions and time, then the coach's three parts", () => {
    renderCard();
    const { content } = weeklyReviewCardFixture();

    expect(screen.getByText("5–11 Oct")).toHaveClass("text-caption", "text-ink-2");
    expect(screen.getByText(content.headline)).toHaveClass(
      "text-body",
      "font-semibold",
      "text-ink",
    );
    expect(stat("Distance")).toHaveTextContent(/^Distance31\.4of 38\.0 km$/);
    expect(stat("Sessions")).toHaveTextContent(/^Sessions4of 5$/);
    expect(stat("Time")).toHaveTextContent(/^Time3:04:12$/);
    expect(stat("Distance")?.lastElementChild).toHaveClass("text-figure", "text-ink");

    const parts = screen.getAllByRole("heading", { level: 3 });
    expect(parts.map((part) => part.textContent)).toEqual([
      "What happened",
      "What it means",
      "Next week",
      "Plan changes",
    ]);
    for (const part of parts) expect(part).toHaveClass("text-caption", "text-ink-2");
    expect(parts[0]?.nextElementSibling).toHaveTextContent(content.whatHappened);
    expect(parts[1]?.nextElementSibling).toHaveTextContent(content.whatItMeans);
    expect(parts[2]?.nextElementSibling).toHaveTextContent(content.nextWeek);
  });

  it("gives the distances of the week and of its changes in mi when the runner uses miles (unit conversion)", () => {
    renderCard(weeklyReviewCardFixture(), { units: "mi" });

    expect(stat("Distance")).toHaveTextContent(/^Distance19\.5of 23\.6 mi$/);
    expect(screen.getByText("Sun 18 Long run 11.2 mi → Long run 10.1 mi")).toBeInTheDocument();
  });

  it("lists each change the engine made as before → after with the coach's note, without the limits caption when applied as proposed", () => {
    renderCard();

    const changes = screen.getByRole("heading", { name: "Plan changes" }).parentElement!;
    const items = within(changes).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]!).getByText("Sun 18 Long run 18.0 km → Long run 16.2 km")).toHaveClass(
      "text-body",
      "text-ink",
    );
    expect(within(items[0]!).getByText(reviewChangeFixture().note)).toHaveClass(
      "text-body",
      "text-ink-2",
    );
    expect(screen.queryByText("Kept inside the plan's limits")).not.toBeInTheDocument();
  });

  it("says a change was kept inside the plan's limits when the engine clamped the coach's proposal (clamped change)", () => {
    const rise = reviewChangeFixture({
      kind: "scale",
      clamped: true,
      date: "2026-10-13",
      sessionId: planSessionId("2026-10-13"),
      before: { ...reviewChangeFixture().before, type: "easy" },
      after: {
        ...reviewChangeFixture().before,
        type: "easy",
        target: { distanceM: 19800, durationS: 7170, zone: "easy" },
      },
      note: "You handled last week well.",
    });
    renderCard(weeklyReviewCardFixture({ changes: [rise, reviewChangeFixture()] }));

    const items = within(
      screen.getByRole("heading", { name: "Plan changes" }).parentElement!,
    ).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/^Tue 13 Easy 18\.0 km → Easy 19\.8 km/);
    expect(within(items[0]!).getByText("Kept inside the plan's limits")).toHaveClass(
      "text-caption",
      "text-ink-2",
    );
    expect(within(items[1]!).queryByText("Kept inside the plan's limits")).toBeNull();
  });

  it("reads a rest the review made as the session skipped (review rest)", () => {
    const before = reviewChangeFixture().before;
    const rest = reviewChangeFixture({ kind: "rest", after: { ...before, status: "skipped" } });
    renderCard(weeklyReviewCardFixture({ changes: [rest] }));

    expect(screen.getByText("Sun 18 Long run 18.0 km skipped")).toBeInTheDocument();
  });

  it("leaves out the changes part when the review changed nothing", () => {
    renderCard(weeklyReviewCardFixture({ changes: [] }));

    expect(screen.queryByRole("heading", { name: "Plan changes" })).not.toBeInTheDocument();
  });

  it("marks a week a pause covered beside its dates (paused week)", () => {
    const summary = { ...weeklyReviewCardFixture().summary, paused: true };
    renderCard(weeklyReviewCardFixture({ summary }));

    const dates = screen.getByText("5–11 Oct").closest("p");
    expect(dates).toHaveTextContent(/^5–11 Oct·Training paused$/);
    expect(dates).toHaveClass("text-caption", "text-ink-2");
  });

  it("names the year of a week from another year than today's", () => {
    renderCard(weeklyReviewCardFixture({ weekStart: "2025-10-06" }));

    expect(screen.getByText("6–12 Oct 2025")).toBeInTheDocument();
  });

  it("shows a fallback card's reason as its own sentence without the What it means label, and without thumbs or Try again (fallback card)", () => {
    const fallback = fallbackReviewFixture("unavailable");
    renderCard(fallback);

    const reason = screen.getByText(fallback.content.whatItMeans);
    expect(reason).toHaveClass("text-body", "text-ink");
    const parts = screen.getAllByRole("heading", { level: 3 });
    expect(parts.map((part) => part.textContent)).toEqual(["What happened", "Next week"]);
    expect(parts[0]?.parentElement?.nextElementSibling).toBe(reason);
    expect(reason.nextElementSibling).toBe(parts[1]?.parentElement);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers thumbs on the model's card, and sends the tapped one with the review's id (thumbs stored)", async () => {
    const setFeedback = vi.fn();
    renderCard(weeklyReviewCardFixture({ feedback: "up" }), { setFeedback });

    const helpful = screen.getByRole("button", { name: "Helpful" });
    expect(helpful).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Not helpful" }));
    expect(setFeedback).toHaveBeenLastCalledWith(REVIEW_ID, "down");
    await userEvent.click(helpful);
    expect(setFeedback).toHaveBeenLastCalledWith(REVIEW_ID, null);
  });

  it("says why saving a thumb failed", () => {
    renderCard(weeklyReviewCardFixture(), { feedbackError: new Error("boom") });

    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
  });

  it("leaves out the coming week unless asked, as on Today", () => {
    renderCard();

    expect(screen.queryByRole("region", { name: "Coming week" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("previews the coming week on the review screen: each session's day, type and distance, opening its screen", async () => {
    const { router } = renderCard(weeklyReviewCardFixture(), { comingWeek: true });

    const week = screen.getByRole("region", { name: "Coming week" });
    expect(within(week).getByRole("heading", { name: "Coming week" })).toHaveClass(
      "text-body",
      "font-semibold",
    );
    const links = within(week).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Tue 13 Oct, Easy, 7.5 km",
      "Wed 14 Oct, Strength, 30:00",
      "Thu 15 Oct, Tempo, 8.2 km",
      "Fri 16 Oct, Easy, 5.0 km",
      "Sun 18 Oct, Long run, 16.2 km",
    ]);
    expect(links[0]).toHaveAttribute("href", `/plan/sessions/${planSessionId("2026-10-13")}`);

    await userEvent.click(links[4]!);
    expect(router.state.location.pathname).toBe(`/plan/sessions/${planSessionId("2026-10-18")}`);
  });

  it("says what happened to a coming session that is done, missed or skipped, a skipped one without its distance", () => {
    const sessions = weeklyReviewCardFixture().comingWeek;
    const comingWeek = sessions.map((session, position) =>
      position === 0
        ? { ...session, status: "done" as const }
        : position === 2
          ? { ...session, status: "skipped" as const }
          : position === 3
            ? { ...session, status: "missed" as const }
            : session,
    );
    renderCard(weeklyReviewCardFixture({ comingWeek }), { comingWeek: true });

    const links = within(screen.getByRole("region", { name: "Coming week" })).getAllByRole("link");
    expect(links[0]).toHaveTextContent(/Done7\.5 km$/);
    expect(links[2]).toHaveAccessibleName("Thu 15 Oct, Tempo, Skipped");
    expect(links[2]).not.toHaveTextContent("8.2 km");
    expect(links[3]).toHaveAccessibleName("Fri 16 Oct, Easy, Missed, 5.0 km");
  });

  it("gives the coming week's distances in mi when the runner uses miles (unit conversion)", () => {
    renderCard(weeklyReviewCardFixture(), { units: "mi", comingWeek: true });

    const links = within(screen.getByRole("region", { name: "Coming week" })).getAllByRole("link");
    expect(links[4]).toHaveAccessibleName("Sun 18 Oct, Long run, 10.1 mi");
  });

  it("shows no coming week when the plan has no sessions after the reviewed week", () => {
    renderCard(weeklyReviewCardFixture({ comingWeek: [] }), { comingWeek: true });

    expect(screen.queryByRole("region", { name: "Coming week" })).not.toBeInTheDocument();
  });
});
