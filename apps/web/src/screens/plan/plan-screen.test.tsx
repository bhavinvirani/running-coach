import type { MeResponse, PlanResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planKey } from "@/api/plan";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { goalFixture, meFixture, planFixture, planResponseFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { PlanScreen } from "./plan-screen";

/** /api/me and GET /api/plan, in memory. */
function fakePlanApi({
  me = meFixture(),
  plan = planResponseFixture(),
}: { me?: MeResponse; plan?: PlanResponse | (() => Response | Promise<Response>) } = {}) {
  return stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/plan") {
      return typeof plan === "function" ? plan() : json(plan);
    }
    return notFound();
  });
}

function renderPlan() {
  return renderScreen(<PlanScreen />, { path: "/plan" });
}

const milesMe = meFixture({ settings: { ...meFixture().settings, units: "mi" } });

/** The week cards' links, in order. */
async function weekLinks() {
  const weeks = await screen.findByRole("region", { name: "Weeks" });
  return within(weeks).getAllByRole("link");
}

/** The colored bar under each day of a week card, Monday first, as its color class. */
function dayColors(card: HTMLElement): string[] {
  return Array.from(card.querySelectorAll("[class*='bg-type-']")).map(
    (bar) => Array.from(bar.classList).find((name) => name.startsWith("bg-type-")) ?? "",
  );
}

describe("PlanScreen", () => {
  // Wed 14 Oct 2026, 10:00 in London: the plan's second week. Only Date is faked.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderPlan();

    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading your plan" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(planResponseFixture());
    });
    renderPlan();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("region", { name: "Goal" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the plan and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      return failing ? problem(503, ErrorCode.internal) : json(planResponseFixture());
    });
    const { queryClient } = renderPlan();
    expect(await weekLinks()).toHaveLength(3);

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: planKey }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(await weekLinks()).toHaveLength(3);

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("asks for a goal with one sentence and one Set goal link when there is none (empty)", async () => {
    fakePlanApi({ plan: { goal: null, plan: null } });
    const { router } = renderPlan();

    expect(await screen.findByText("Set a goal to get a training plan.")).toHaveClass(
      "text-body",
      "text-ink-2",
    );
    const setGoal = screen.getByRole("link", { name: "Set goal" });
    expect(setGoal).toHaveAttribute("href", "/plan/goal");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Weeks" })).not.toBeInTheDocument();

    await userEvent.click(setGoal);

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plan/goal");
  });

  it("shows the weeks until the race as the figure, the race by name, its day and runs a week, then its target beside the race pace", async () => {
    fakePlanApi();
    renderPlan();

    const goal = await screen.findByRole("region", { name: "Goal" });
    // Wed 14 Oct is in the second of the plan's three weeks: this week and race week are left.
    const figure = within(goal).getByText("2");
    expect(figure).toHaveClass("text-figure");
    expect(figure).toHaveTextContent(/^2weeks$/);
    expect(within(figure).getByText("weeks")).toHaveClass("text-caption", "text-ink-2");
    expect(within(goal).getByText("Race on 25 Oct 2026").closest("p")).toHaveTextContent(
      /^10K·Race on 25 Oct 2026·4 runs a week$/,
    );
    const paceLine = within(goal).getByText("Target 49:00").closest("p");
    expect(paceLine).toHaveTextContent(/^Target 49:00·Race pace 4:54-4:58 \/km, about 49:20$/);
    expect(paceLine).toHaveClass("text-caption", "text-ink-2");
    expect(within(goal).getByRole("link", { name: "Change goal" })).toHaveAttribute(
      "href",
      "/plan/goal",
    );
  });

  it("names a half marathon in full beside its race day", async () => {
    fakePlanApi({
      plan: planResponseFixture({ goal: goalFixture({ distanceKey: "half", targetTimeS: null }) }),
    });
    renderPlan();

    const goal = await screen.findByRole("region", { name: "Goal" });
    expect(within(goal).getByText("Race on 25 Oct 2026").closest("p")).toHaveTextContent(
      /^Half marathon·Race on 25 Oct 2026·4 runs a week$/,
    );
  });

  it("shows a fitness plan's weeks as the figure and names it Fitness with its focus distance, without a race day", async () => {
    vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
    fakePlanApi({
      plan: planResponseFixture({
        goal: goalFixture({ kind: "fitness", raceDate: null, targetTimeS: null }),
      }),
    });
    renderPlan();

    const goal = await screen.findByRole("region", { name: "Goal" });
    // Before the plan starts, every one of its weeks is left.
    expect(within(goal).getByText("3")).toHaveClass("text-figure");
    expect(within(goal).getByText("Fitness").closest("p")).toHaveTextContent(
      /^Fitness·10K focus·4 runs a week$/,
    );
    expect(within(goal).getByText("Race pace 4:54-4:58 /km, about 49:20")).toBeInTheDocument();
  });

  it("shows the paces as tiles, easy first, in km", async () => {
    fakePlanApi();
    renderPlan();

    const paces = await screen.findByRole("list", { name: "Paces" });
    const tiles = within(paces).getAllByRole("listitem");
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      "Easy5:45-6:20 /km",
      "Marathon5:15-5:22 /km",
      "Threshold5:00-5:07 /km",
      "Interval4:45-4:52 /km",
      "Repetition4:30-4:35 /km",
      "Race4:54-4:58 /km",
    ]);
  });

  it("says each warning in one sentence", async () => {
    fakePlanApi({
      plan: planResponseFixture({
        plan: planFixture({
          warnings: [
            { code: "race_date_close", weeks: 3, minimumWeeks: 8 },
            { code: "no_recent_runs", startVolumeM: 15000 },
            { code: "start_volume_lifted", recentWeeklyM: 8000, startVolumeM: 13000 },
          ],
        }),
      }),
    });
    renderPlan();

    const notes = await screen.findByRole("list", { name: "Plan notes" });
    expect(
      within(notes)
        .getAllByRole("listitem")
        .map((note) => note.textContent),
    ).toEqual([
      "The race is 3 weeks away, under the 8 weeks a plan for it usually takes: this plan is the taper and what fits before it.",
      "No runs in the last 4 weeks, so the plan starts from 15.0 km a week.",
      "Your recent 8.0 km a week is under what 4 runs need, so the plan starts at 13.0 km.",
    ]);
  });

  it("leaves out the notes when the plan has no warning", async () => {
    fakePlanApi({ plan: planResponseFixture({ plan: planFixture({ warnings: [] }) }) });
    renderPlan();

    await weekLinks();
    expect(screen.queryByRole("list", { name: "Plan notes" })).not.toBeInTheDocument();
  });

  it("shows one card per week with its phase, distance and dates, each opening its week", async () => {
    fakePlanApi();
    renderPlan();

    const links = await weekLinks();
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/plan/weeks/1",
      "/plan/weeks/2",
      "/plan/weeks/3",
    ]);
    expect(links[0]).toHaveAccessibleName(
      "Week 1, Base, 38.0 km, 5–11 Oct, Mon Rest, Tue Easy, Wed Strength, Thu Intervals, Fri Easy, Sat Rest, Sun Long run",
    );
    expect(links[2]).toHaveAccessibleName(
      "Week 3, Race week, 27.3 km, 19–25 Oct, Mon Rest, Tue Easy, Wed Rest, Thu Race practice, Fri Easy, Sat Rest, Sun Race",
    );
    // The down week before the race reads as less distance than the week before it.
    expect(within(links[1]!).getByText("38.6")).toHaveClass("text-figure");
    expect(within(links[2]!).getByText("27.3")).toHaveClass("text-figure");
  });

  it("draws each day as its initial over a bar in its session type's color, rest in grey", async () => {
    fakePlanApi();
    renderPlan();

    const [first, , last] = await weekLinks();
    expect(
      within(first!)
        .getAllByText(/^[MTWFS]$/)
        .map((cell) => cell.textContent),
    ).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    expect(dayColors(first!)).toEqual([
      "bg-type-rest",
      "bg-type-easy",
      "bg-type-strength",
      "bg-type-intervals",
      "bg-type-easy",
      "bg-type-rest",
      "bg-type-long",
    ]);
    // Race practice and the race share the race color.
    expect(dayColors(last!)).toEqual([
      "bg-type-rest",
      "bg-type-easy",
      "bg-type-rest",
      "bg-type-race",
      "bg-type-easy",
      "bg-type-rest",
      "bg-type-race",
    ]);
  });

  it("selects the week that holds today with border-line-selected and names it this week", async () => {
    fakePlanApi();
    renderPlan();

    const [first, second, third] = await weekLinks();
    expect(second).toHaveClass("border-line-selected");
    expect(second).toHaveAccessibleName(expect.stringContaining("12–18 Oct, this week,"));
    for (const other of [first, third]) {
      expect(other).toHaveClass("border-line");
      expect(other).not.toHaveClass("border-line-selected");
    }
  });

  it("selects no week before the plan starts (time zones: still Sunday in New York)", async () => {
    // Mon 5 Oct, 03:00 UTC: the plan's first Monday in London, still Sunday 4 Oct in New York.
    vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
    const newYork = meFixture({
      settings: { ...meFixture().settings, timezone: "America/New_York" },
    });
    fakePlanApi({ me: newYork });
    renderPlan();

    const links = await weekLinks();
    for (const link of links) expect(link).not.toHaveClass("border-line-selected");
  });

  it("opens a week from its card", async () => {
    fakePlanApi();
    const { router } = renderPlan();

    const [, second] = await weekLinks();
    await userEvent.click(second!);

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plan/weeks/2");
  });

  it("converts paces and week distances to mi when the runner uses miles (unit conversion)", async () => {
    fakePlanApi({ me: milesMe });
    renderPlan();

    const paces = await screen.findByRole("list", { name: "Paces" });
    // 345 and 380 s/km are 555.2 and 611.6 s/mi; 285 and 292 are 458.7 and 469.9.
    expect(within(paces).getByText("9:15-10:12 /mi")).toBeInTheDocument();
    expect(within(paces).getByText("7:39-7:50 /mi")).toBeInTheDocument();
    // The goal card's race pace too; the finish time it means is the same in either unit.
    expect(
      within(screen.getByRole("region", { name: "Goal" })).getByText(
        "Race pace 7:53-8:00 /mi, about 49:20",
      ),
    ).toBeInTheDocument();
    const [first] = await weekLinks();
    // 38,030 m is 23.6 mi.
    expect(within(first!).getByText("23.6")).toHaveClass("text-figure");
    expect(within(first!).getByText("mi")).toBeInTheDocument();
    expect(first).toHaveAccessibleName(expect.stringContaining("Week 1, Base, 23.6 mi,"));
  });
});
