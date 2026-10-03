import type { GoalInput, MeResponse, PlanResponse, SaveGoalResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A time field's group by its label: "Target time", or the recent race's "Time". */
function timeField(name: string) {
  return screen.getByRole("group", { name });
}

/** A time field's hours, minutes and seconds pickers, as their values. */
function pickedTime(name: string): string[] {
  return within(timeField(name))
    .getAllByRole("combobox")
    .map((select) => (select as HTMLSelectElement).value);
}

/** Picks each part given, as a thumb would on the native wheels. */
async function pickTime(
  name: string,
  parts: { hours?: string; minutes?: string; seconds?: string },
): Promise<void> {
  const field = timeField(name);
  if (parts.hours) {
    await userEvent.selectOptions(within(field).getByLabelText("Hours"), parts.hours);
  }
  if (parts.minutes) {
    await userEvent.selectOptions(within(field).getByLabelText("Minutes"), parts.minutes);
  }
  if (parts.seconds) {
    await userEvent.selectOptions(within(field).getByLabelText("Seconds"), parts.seconds);
  }
}

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

  it("keeps the form and its edits and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      return failing ? problem(503, ErrorCode.internal) : json(planResponseFixture());
    });
    const { queryClient } = renderGoal();
    const target = await screen.findByRole("region", { name: "Target" });
    await userEvent.click(within(target).getByRole("radio", { name: "Half" }));

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: planKey }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(within(section("Target")).getByRole("radio", { name: "Half" })).toBeChecked();

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(within(section("Target")).getByRole("radio", { name: "Half" })).toBeChecked();
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
    const targetTime = within(target).getByRole("group", { name: "Target time" });
    expect(within(targetTime).getByRole("checkbox", { name: "No target" })).toBeChecked();
    expect(within(targetTime).queryByRole("combobox")).not.toBeInTheDocument();
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
    expect(within(target).getByRole("checkbox", { name: "No target" })).not.toBeChecked();
    expect(pickedTime("Target time")).toEqual(["0", "49", "0"]);
    expect(timeField("Target time")).toHaveAccessibleDescription("Pace 4:54 /km");
    expect(within(section("Training week")).getByRole("radio", { name: "Sat" })).toBeChecked();
    const recent = section("Recent race");
    expect(within(recent).getByRole("radio", { name: "5K" })).toBeChecked();
    expect(pickedTime("Time")).toEqual(["0", "24", "30"]);
    expect(timeField("Time")).toHaveAccessibleDescription("Pace 4:54 /km");
  });

  it("saves the goal with the parsed body, puts the new plan in the cache and opens it", async () => {
    const calls = fakeGoalApi();
    const { router, queryClient } = renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    await userEvent.click(within(target).getByRole("radio", { name: "Half" }));
    await userEvent.type(within(target).getByLabelText("Race date"), "2027-03-14");
    await userEvent.click(within(target).getByRole("checkbox", { name: "No target" }));
    await pickTime("Target time", { hours: "1", minutes: "45" });
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
    expect(within(target).queryByRole("group", { name: "Target time" })).not.toBeInTheDocument();
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

  it("names the week the days need and the recent volume in mi when there are too many days for it (unit conversion)", async () => {
    fakeGoalApi({
      me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }),
      plan: planResponseFixture(),
      save: conflict({
        code: "too_many_days",
        daysPerWeek: 6,
        maxDaysPerWeek: 4,
        recentWeeklyM: 16093,
        neededWeeklyM: 24140,
      }),
    });
    renderGoal();

    await userEvent.click(await screen.findByRole("radio", { name: "6" }));
    await userEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "6 runs a week need at least 15.0 mi, more than 10% over the 10.0 mi a week you have been running. Pick 4 days or fewer.",
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
    await pickTime("Time", { minutes: "50" });
    await userEvent.click(save());

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plan");
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts[1]?.body).toMatchObject({ recentTime: { distanceKey: "10k", timeS: 3000 } });
  });

  it("keeps the recent race open with its time when a later save answers another conflict (no recent time)", async () => {
    const calls = fakeGoalApi({
      plan: planResponseFixture(),
      save: (_goal, attempt) =>
        attempt === 1
          ? conflict({ code: "no_recent_time" })()
          : conflict({
              code: "too_many_days",
              daysPerWeek: 4,
              maxDaysPerWeek: 3,
              recentWeeklyM: 9000,
              neededWeeklyM: 22000,
            })(),
    });
    renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Save goal" }));
    await screen.findByRole("region", { name: "Recent race" });
    await pickTime("Time", { minutes: "24", seconds: "30" });
    await userEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(/^4 runs a week need at least/);
    expect(section("Recent race")).toBeInTheDocument();
    expect(pickedTime("Time")).toEqual(["0", "24", "30"]);
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1]?.body).toMatchObject({ recentTime: { distanceKey: "5k", timeS: 1470 } });

    // Saved again, the time is still sent: nothing the runner entered was dropped.
    await userEvent.click(save());
    await vi.waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(3));
    expect(calls.filter((call) => call.method === "PUT")[2]?.body).toMatchObject({
      recentTime: { distanceKey: "5k", timeS: 1470 },
    });
  });

  it("says under the time pickers that a recent time no run could take is wrong, without sending it (implausible recent time)", async () => {
    const calls = fakeGoalApi({ plan: planResponseFixture() });
    renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Add a recent race time" }));
    // 5:00 for a 5K is 1:00 /km, faster than the GPS glitch pace.
    await pickTime("Time", { minutes: "5" });
    await userEvent.click(save());

    const alert = within(timeField("Time")).getByRole("alert");
    expect(alert).toHaveTextContent(
      "That time is faster or slower than any run; check the hours and minutes",
    );
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    await pickTime("Time", { minutes: "25" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains a recent time the API refuses with the error text above Save goal, not under the pickers (validation)", async () => {
    fakeGoalApi({ plan: planResponseFixture(), save: () => problem(400, ErrorCode.validation) });
    renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Add a recent race time" }));
    await pickTime("Time", { minutes: "25" });
    await userEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.validation);
    expect(within(timeField("Time")).queryByRole("alert")).not.toBeInTheDocument();
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

  it("names the latest race date a plan reaches when the race is further out (race too far)", async () => {
    fakeGoalApi({
      plan: planResponseFixture(),
      save: conflict({
        code: "race_too_far",
        raceDate: "2027-12-12",
        latestRaceDate: "2027-10-03",
      }),
    });
    renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Save goal" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The race is further out than a plan covers: pick a date up to 3 Oct 2027.",
    );
  });

  describe("on Fri 2 Oct 2026 in London", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("offers race dates up to 52 weeks and 6 days ahead in the picker, and sends a later typed date for the API to answer (race too far)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // 23:30 UTC on 1 Oct is 00:30 on 2 Oct in London: the runner's day, not the device's UTC one.
      vi.setSystemTime(new Date("2026-10-01T23:30:00Z"));
      const calls = fakeGoalApi({
        plan: planResponseFixture(),
        save: conflict({
          code: "race_too_far",
          raceDate: "2027-12-12",
          latestRaceDate: "2027-10-03",
        }),
      });
      renderGoal();

      const raceDate = await screen.findByLabelText("Race date");
      expect(raceDate).toHaveAttribute("max", "2027-10-07");
      await userEvent.clear(raceDate);
      await userEvent.type(raceDate, "2027-12-12");
      await userEvent.click(save());

      expect(await screen.findByRole("alert")).toHaveTextContent(/pick a date up to 3 Oct 2027/);
      expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({
        raceDate: "2027-12-12",
      });
    });
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

  it("asks for a target time when No target is unticked at 0:00:00, and forgets the sentence once a time is picked", async () => {
    const calls = fakeGoalApi({
      plan: planResponseFixture({ goal: goalFixture({ targetTimeS: null }) }),
    });
    renderGoal();

    await userEvent.click(await screen.findByRole("checkbox", { name: "No target" }));
    expect(pickedTime("Target time")).toEqual(["0", "0", "0"]);
    await userEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pick a target time, or tick No target.",
    );
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    await pickTime("Target time", { minutes: "48" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends null once No target is ticked again, whatever time the pickers hold (no target)", async () => {
    const calls = fakeGoalApi({ plan: planResponseFixture() });
    renderGoal();

    await userEvent.click(await screen.findByRole("checkbox", { name: "No target" }));
    expect(within(timeField("Target time")).queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(save());

    await screen.findByText("Route not under test");
    expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({ targetTimeS: null });
  });

  it("shows the pace a target time means for the race distance, live as the pickers and distance change", async () => {
    fakeGoalApi({ plan: planResponseFixture({ goal: goalFixture({ targetTimeS: null }) }) });
    renderGoal();

    const target = await screen.findByRole("region", { name: "Target" });
    await userEvent.click(within(target).getByRole("radio", { name: "Half" }));
    await userEvent.click(within(target).getByRole("checkbox", { name: "No target" }));
    expect(timeField("Target time")).not.toHaveAccessibleDescription();

    await pickTime("Target time", { hours: "1", minutes: "43" });
    const caption = within(timeField("Target time")).getByText("Pace 4:53 /km");
    expect(caption).toHaveClass("text-caption", "text-ink-2");

    await pickTime("Target time", { seconds: "30" });
    expect(timeField("Target time")).toHaveAccessibleDescription("Pace 4:54 /km");
    await userEvent.click(within(target).getByRole("radio", { name: "Marathon" }));
    expect(timeField("Target time")).toHaveAccessibleDescription("Pace 2:27 /km");
  });

  it("shows the target and recent paces per mile for a runner in miles (unit conversion)", async () => {
    fakeGoalApi({
      me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }),
      plan: planResponseFixture({
        goal: goalFixture({ recentTime: { distanceKey: "1mi", timeS: 400 } }),
      }),
    });
    renderGoal();

    await screen.findByRole("region", { name: "Recent race" });
    // 49:00 over 6.21 mi is 473.3 s/mi.
    expect(timeField("Target time")).toHaveAccessibleDescription("Pace 7:53 /mi");
    expect(timeField("Time")).toHaveAccessibleDescription("Pace 6:40 /mi");
  });

  it("shows the recent time's pace for the recent distance, and none at 0:00:00", async () => {
    fakeGoalApi({ plan: planResponseFixture() });
    renderGoal();

    await userEvent.click(await screen.findByRole("button", { name: "Add a recent race time" }));
    expect(pickedTime("Time")).toEqual(["0", "0", "0"]);
    expect(timeField("Time")).not.toHaveAccessibleDescription();

    await pickTime("Time", { minutes: "54", seconds: "41" });
    expect(timeField("Time")).toHaveAccessibleDescription("Pace 10:56 /km");
    await userEvent.click(within(section("Recent race")).getByRole("radio", { name: "10K" }));
    expect(timeField("Time")).toHaveAccessibleDescription("Pace 5:28 /km");
  });
});
