import type { MeResponse, PlanResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { planKey } from "@/api/plan";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { meFixture, planResponseFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { PlanWeekScreen } from "./plan-week-screen";

function fakePlanApi({
  me = meFixture(),
  plan = planResponseFixture(),
}: { me?: MeResponse; plan?: PlanResponse } = {}) {
  return stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/plan") return json(plan);
    return notFound();
  });
}

function renderWeek(number: string | number) {
  return renderScreen(<PlanWeekScreen />, {
    path: `/plan/weeks/${number}`,
    route: "/plan/weeks/:number",
  });
}

/** The day rows, Monday first. */
async function dayRows() {
  const days = await screen.findByRole("region", { name: "Days" });
  return within(days).getAllByRole("listitem");
}

describe("PlanWeekScreen", () => {
  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderWeek(1);

    expect(screen.getByRole("status", { name: "Loading the week" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/plan");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(planResponseFixture());
    });
    renderWeek(1);

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Week 1" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the week and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      return failing ? problem(503, ErrorCode.internal) : json(planResponseFixture());
    });
    const { queryClient } = renderWeek(2);
    expect(await dayRows()).toHaveLength(7);

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: planKey }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("heading", { name: "Week 2" })).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("says the plan has no such week and links back to the plan (unknown week)", async () => {
    fakePlanApi();
    const { router } = renderWeek(9);

    expect(await screen.findByText("Your plan has no week 9.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Week" })).toBeInTheDocument();
    const open = screen.getByRole("link", { name: "Open plan" });
    expect(open).toHaveAttribute("href", "/plan");

    await userEvent.click(open);
    expect(router.state.location.pathname).toBe("/plan");
  });

  it.each(["0", "two", "1.5"])(
    "treats week %j as a week the plan does not have",
    async (number) => {
      fakePlanApi();
      renderWeek(number);

      expect(await screen.findByText(`Your plan has no week ${number}.`)).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Days" })).not.toBeInTheDocument();
    },
  );

  it("says there is no plan yet and links to the plan (no plan)", async () => {
    fakePlanApi({ plan: { goal: null, plan: null } });
    renderWeek(1);

    expect(await screen.findByText("You have no plan yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open plan" })).toHaveAttribute("href", "/plan");
  });

  it("shows the week's distance as the figure with its phase and dates under the title", async () => {
    fakePlanApi();
    renderWeek(1);

    expect(await screen.findByRole("heading", { name: "Week 1" })).toBeInTheDocument();
    expect(screen.getByText("38.0")).toHaveClass("text-figure");
    expect(screen.getByText("Base").closest("p")).toHaveTextContent(/^Base·5–11 Oct$/);
  });

  it("lists every day Monday to Sunday with its type, distance, time and steps in km, a lone run as its band", async () => {
    fakePlanApi();
    renderWeek(1);

    const rows = await dayRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      "Mon 5 OctRest",
      "Tue 6 OctEasy7.5 km45:005:45-6:20 /km easy",
      "Wed 7 OctStrength30:00",
      "Thu 8 OctIntervals11.6 km1:04:0015 min easy, 5 x 1 km at 4:45-4:52 /km with 3 min jog, 10 min easy",
      "Fri 9 OctEasy5.0 km30:005:45-6:20 /km easy",
      "Sat 10 OctRest",
      "Sun 11 OctLong run14.0 km1:24:305:45-6:20 /km easy",
    ]);
    expect(within(rows[0]!).getByText("Rest").querySelector("span")).toHaveClass("bg-type-rest");
    expect(within(rows[3]!).getByText("Intervals").querySelector("span")).toHaveClass(
      "bg-type-intervals",
    );
  });

  it("shows race practice at race pace and the race on race day as its race pace band", async () => {
    fakePlanApi();
    renderWeek(3);

    const rows = await dayRows();
    expect(rows[3]).toHaveTextContent(
      /^Thu 22 OctRace practice7\.3 km40:4810 min easy, 3 x 1 km at 4:54-4:58 \/km with 2 min jog, 10 min easy$/,
    );
    expect(rows[6]).toHaveTextContent(/^Sun 25 OctRace10\.0 km49:204:54-4:58 \/km race pace$/);
    expect(within(rows[6]!).getByText("Race").querySelector("span")).toHaveClass("bg-type-race");
  });

  it("converts distances and paces to mi when the runner uses miles (unit conversion)", async () => {
    fakePlanApi({ me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }) });
    renderWeek(1);

    const rows = await dayRows();
    // 38,030 m is 23.6 mi; 11,610 m is 7.2 mi; 1 km reps stay in meters, under a mile; easy 345-380 s/km
    // is 555.2-611.6 s/mi.
    expect(screen.getByText("23.6")).toHaveClass("text-figure");
    expect(rows[3]).toHaveTextContent(
      /^Thu 8 OctIntervals7\.2 mi1:04:0015 min easy, 5 x 1000 m at 7:39-7:50 \/mi with 3 min jog, 10 min easy$/,
    );
    expect(rows[6]).toHaveTextContent(/^Sun 11 OctLong run8\.7 mi1:24:309:15-10:12 \/mi easy$/);
  });

  it("goes back to the plan from Back when opened from a link", async () => {
    fakePlanApi();
    const { router } = renderWeek(2);
    await screen.findByRole("heading", { name: "Week 2" });

    await userEvent.click(screen.getByRole("link", { name: "Back" }));

    expect(router.state.location.pathname).toBe("/plan");
  });
});
