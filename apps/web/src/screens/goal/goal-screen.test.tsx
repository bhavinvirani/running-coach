import type { GoalInput, MeResponse, PlanResponse, SaveGoalResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { planKey } from "@/api/plan";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { goalFixture, meFixture, planFixture, planResponseFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { GoalScreen } from "./goal-screen";

type SaveAnswer = (goal: GoalInput, attempt: number) => Response | Promise<Response>;

/** What PUT /api/goal answers for a goal the engine can plan: the goal saved, with its plan. */
function saved(goal: GoalInput): Response {
  const body: SaveGoalResponse = {
    ok: true,
    goal: goalFixture({ ...goal, updatedAt: "2026-10-02T09:00:00Z" }),
    plan: planFixture({ version: 2 }),
  };
  return json(body);
}

/** /api/me, GET /api/plan and PUT /api/goal, in memory. */
function fakeGoalApi({
  me = meFixture(),
  plan = { goal: null, plan: null },
  save = saved,
}: { me?: MeResponse; plan?: PlanResponse; save?: SaveAnswer } = {}) {
  let saves = 0;
  return stubFetch(({ method, path, body }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/plan") return json(plan);
    if (method === "PUT" && path === "/api/goal") {
      saves += 1;
      return save(body as GoalInput, saves);
    }
    return notFound();
  });
}

function renderGoal() {
  return renderScreen(<GoalScreen />, { path: "/plan/goal" });
}

function section(name: string) {
  return screen.getByRole("region", { name });
}

function conflict(body: Extract<SaveGoalResponse, { ok: false }>["conflict"]) {
  return () => json({ ok: false, conflict: body } satisfies SaveGoalResponse);
}

const save = () => screen.getByRole("button", { name: "Save goal" });

describe("GoalScreen", () => {
  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderGoal();

    expect(screen.getByRole("heading", { name: "Goal" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading your goal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/plan");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(planResponseFixture());
    });
    renderGoal();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("radio", { name: "10K" })).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts a first goal as a race on 4 runs a week with the long run on Sunday, distance and date to pick", async () => {
    fakeGoalApi();
    renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    expect(within(target).getByRole("radio", { name: "Race" })).toBeChecked();
    for (const name of ["5K", "10K", "Half", "Marathon"]) {
      expect(within(target).getByRole("radio", { name })).not.toBeChecked();
    }
    expect(within(target).getByLabelText("Race date")).toHaveValue("");
    expect(within(target).getByLabelText("Target time")).toHaveValue("");
    expect(within(target).getByLabelText("Target time")).toHaveAccessibleDescription(
      "Optional. h:mm:ss or mm:ss.",
    );
    const week = section("Training week");
    expect(within(week).getByRole("radio", { name: "4" })).toBeChecked();
    expect(within(week).getByRole("radio", { name: "Sun" })).toBeChecked();
    expect(screen.queryByRole("region", { name: "Recent race" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a recent race time" })).toBeInTheDocument();
    expect(save()).toBeEnabled();
  });

  it("starts from the current goal when there is one", async () => {
    fakeGoalApi({
      plan: planResponseFixture({
        goal: goalFixture({ recentTime: { distanceKey: "5k", timeS: 1470 }, longRunDay: "sat" }),
      }),
    });
    renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    expect(within(target).getByRole("radio", { name: "10K" })).toBeChecked();
    expect(within(target).getByLabelText("Race date")).toHaveValue("2026-10-25");
    expect(within(target).getByLabelText("Target time")).toHaveValue("49:00");
    expect(within(section("Training week")).getByRole("radio", { name: "Sat" })).toBeChecked();
    const recent = section("Recent race");
    expect(within(recent).getByRole("radio", { name: "5K" })).toBeChecked();
    expect(within(recent).getByLabelText("Time")).toHaveValue("24:30");
  });

  it("saves the goal with the parsed body, puts the new plan in the cache and opens it", async () => {
    const calls = fakeGoalApi();
    const { router, queryClient } = renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    await userEvent.click(within(target).getByRole("radio", { name: "Half" }));
    await userEvent.type(within(target).getByLabelText("Race date"), "2027-03-14");
    await userEvent.type(within(target).getByLabelText("Target time"), "1:45:00");
    await userEvent.click(within(section("Training week")).getByRole("radio", { name: "5" }));
    await userEvent.click(within(section("Training week")).getByRole("radio", { name: "Sat" }));
    await userEvent.click(save());

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plan");
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe("/api/goal");
    expect(puts[0]?.body).toEqual({
      kind: "race",
      distanceKey: "half",
      raceDate: "2027-03-14",
      targetTimeS: 6300,
      daysPerWeek: 5,
      longRunDay: "sat",
      recentTime: null,
    });
    expect(queryClient.getQueryData<PlanResponse>(planKey)).toMatchObject({
      goal: { distanceKey: "half", raceDate: "2027-03-14" },
      plan: { version: 2 },
    });
    // The PUT answered with the plan: no second GET.
    expect(calls.filter((call) => call.path === "/api/plan")).toHaveLength(1);
  });

  it("sends a fitness goal without the race date and target time it hides", async () => {
    const calls = fakeGoalApi({ plan: planResponseFixture() });
    renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    await userEvent.click(within(target).getByRole("radio", { name: "Fitness" }));

    expect(within(target).queryByLabelText("Race date")).not.toBeInTheDocument();
    expect(within(target).queryByLabelText("Target time")).not.toBeInTheDocument();
    expect(within(target).getByRole("radio", { name: "10K" })).toBeChecked();
    await userEvent.click(within(target).getByRole("radio", { name: "Any" }));
    await userEvent.click(save());

    await screen.findByText("Route not under test");
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      kind: "fitness",
      distanceKey: null,
      raceDate: null,
      targetTimeS: null,
      daysPerWeek: 4,
      longRunDay: "sun",
      recentTime: null,
    });
  });

  it("checks Any for a fitness goal with no distance, and says what the distance does", async () => {
    fakeGoalApi({
      plan: planResponseFixture({
        goal: goalFixture({
          kind: "fitness",
          distanceKey: null,
          raceDate: null,
          targetTimeS: null,
        }),
      }),
    });
    renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    expect(within(target).getByRole("radio", { name: "Fitness" })).toBeChecked();
    expect(within(target).getByRole("radio", { name: "Any" })).toBeChecked();
    expect(within(target).getByRole("group", { name: "Distance" })).toHaveAccessibleDescription(
      "The distance the sessions are shaped around.",
    );
  });

  it("stays on the form and says why when the goal cannot be planned (marathon on 3 days)", async () => {
    const calls = fakeGoalApi({
      plan: planResponseFixture(),
      save: conflict({
        code: "long_run_cap",
        distanceKey: "marathon",
        daysPerWeek: 3,
        minDaysPerWeek: 4,
      }),
    });
    const { router } = renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    await userEvent.click(within(target).getByRole("radio", { name: "Marathon" }));
    await userEvent.click(within(section("Training week")).getByRole("radio", { name: "3" }));
    await userEvent.click(save());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "A marathon plan needs at least 4 running days a week: with 3, the long run would be over the long-run cap. Add a day or pick a shorter race.",
    );
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(router.state.location.pathname).toBe("/plan/goal");
    expect(save()).toBeEnabled();
    expect(within(target).getByRole("radio", { name: "Marathon" })).toBeChecked();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("names the days and recent volume in mi when there are too many days for it (unit conversion)", async () => {
    fakeGoalApi({
      me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }),
      plan: planResponseFixture(),
      save: conflict({
        code: "too_many_days",
        daysPerWeek: 6,
        maxDaysPerWeek: 4,
        baselineWeeklyM: 16093,
      }),
    });
    renderGoal();

    await userEvent.click(await screen.findByRole("radio", { name: "6" }));
    await userEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "6 runs a week would be more than 10% over the 10.0 mi a week you have been running. Pick 4 days or fewer.",
    );
  });

  it("asks for a recent race time and opens its fields when there is none to set paces from (no recent time)", async () => {
    const calls = fakeGoalApi({
      plan: planResponseFixture(),
      save: (goal, attempt) =>
        attempt === 1 ? conflict({ code: "no_recent_time" })() : saved(goal),
    });
    const { router } = renderGoal();
    expect(
      await screen.findByRole("button", { name: "Add a recent race time" }),
    ).toBeInTheDocument();

    await userEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "There is no recent race or best effort to set your paces from. Enter a recent race time below.",
    );
    const recent = section("Recent race");
    expect(within(recent).getByRole("radio", { name: "5K" })).toBeChecked();
    await userEvent.click(within(recent).getByRole("radio", { name: "10K" }));
    await userEvent.type(within(recent).getByLabelText("Time"), "50:00");
    await userEvent.click(save());

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plan");
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts[1]?.body).toMatchObject({ recentTime: { distanceKey: "10k", timeS: 3000 } });
  });

  it("opens the recent race fields on Add a recent race time and sends null while the time is empty", async () => {
    const calls = fakeGoalApi({ plan: planResponseFixture() });
    renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Add a recent race time" }));

    const recent = section("Recent race");
    expect(within(recent).getByRole("group", { name: "Distance" })).toHaveAccessibleDescription(
      "A race or time trial from the last few months. It sets your paces.",
    );
    expect(
      within(recent)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["1mi", "5k", "10k", "half", "marathon"]);
    expect(
      screen.queryByRole("button", { name: "Add a recent race time" }),
    ).not.toBeInTheDocument();
    await userEvent.click(save());

    await screen.findByText("Route not under test");
    expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({ recentTime: null });
  });

  it("says when the race date is before the plan could start, with the earliest date (race date change)", async () => {
    fakeGoalApi({
      plan: planResponseFixture(),
      save: conflict({
        code: "race_too_soon",
        raceDate: "2026-10-04",
        earliestStart: "2026-10-05",
      }),
    });
    renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Save goal" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The plan would start on 5 Oct 2026, after the race on 4 Oct 2026. Pick a race date on or after 5 Oct 2026.",
    );
  });

  it("explains a refused save with the error text and keeps the form (validation)", async () => {
    fakeGoalApi({ plan: planResponseFixture(), save: () => problem(400, ErrorCode.validation) });
    const { router } = renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Save goal" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.validation);
    expect(router.state.location.pathname).toBe("/plan/goal");
    expect(screen.getByRole("radio", { name: "10K" })).toBeChecked();
  });

  it("reads Saving…, disabled and busy while the goal saves", async () => {
    fakeGoalApi({ plan: planResponseFixture(), save: () => never() });
    renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Save goal" }));

    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it.each([
    { field: "the race distance", fill: false, message: "Pick a race distance." },
    { field: "the race date", fill: true, message: "Pick a race date." },
  ])("asks for $field before sending a race goal", async ({ fill, message }) => {
    const calls = fakeGoalApi();
    renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    if (fill) await userEvent.click(within(target).getByRole("radio", { name: "5K" }));
    await userEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("asks for a target time it can read before sending, and forgets the sentence once the field changes", async () => {
    const calls = fakeGoalApi({ plan: planResponseFixture() });
    renderGoal();

    const targetTime = await screen.findByLabelText("Target time");
    await userEvent.clear(targetTime);
    await userEvent.type(targetTime, "49.30");
    await userEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the target time as h:mm:ss or mm:ss, or leave it empty.",
    );
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    await userEvent.clear(targetTime);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
