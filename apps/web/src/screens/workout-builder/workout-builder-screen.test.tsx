import {
  ErrorCode,
  GARMIN_WORKOUT_STEPS_MAX,
  type CustomSessionInput,
  type MeResponse,
  type PlanResponse,
  type SessionDetailResponse,
} from "@running-coach/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import {
  customSessionFixture,
  meFixture,
  planResponseFixture,
  planSessionFixture,
  sessionDetailFixture,
} from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { WorkoutBuilderScreen } from "./workout-builder-screen";

const custom = customSessionFixture();
const milesMe = meFixture({ settings: { ...meFixture().settings, units: "mi" } });

type FakeBuilderApi = {
  me?: MeResponse;
  plan?: PlanResponse;
  detail?: SessionDetailResponse;
  /** POST or PUT /api/sessions: a problem, else the saved workout. */
  save?: Response;
};

/** GET /api/plan and /api/sessions/:id, and a save that answers the workout as the API stores it. */
function fakeBuilderApi({
  me = meFixture(),
  plan = planResponseFixture(),
  detail = sessionDetailFixture({ session: custom }),
  save,
}: FakeBuilderApi = {}) {
  return stubFetch(({ method, path, body }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/plan") return json(plan);
    if (method === "GET" && path === `/api/sessions/${detail.session.id}`) return json(detail);
    if ((method === "POST" && path === "/api/sessions") || method === "PUT") {
      if (save) return save;
      const input = body as CustomSessionInput;
      return json(sessionDetailFixture({ session: { ...custom, ...input } }));
    }
    return notFound();
  });
}

function renderNew(date: string | null = "2026-10-10", options: { history?: string[] } = {}) {
  const path = date === null ? "/plan/sessions/new" : `/plan/sessions/new?date=${date}`;
  return renderScreen(<WorkoutBuilderScreen />, {
    path,
    route: "/plan/sessions/new",
    ...options,
  });
}

function renderEdit(id: string = custom.id, history: string[] = []) {
  return renderScreen(<WorkoutBuilderScreen />, {
    path: `/plan/sessions/${id}/edit`,
    route: "/plan/sessions/:id/edit",
    history,
  });
}

/** Each step's kind, amount and unit, top level and inside repeats, in order. */
function stepValues() {
  return screen.getAllByRole("group", { name: /^Step / }).map((step) => {
    const label = step.getAttribute("aria-label")!.replace("Step ", "");
    const kind = within(step).getByLabelText<HTMLSelectElement>(`Kind of step ${label}`);
    const amount = within(step).getByLabelText<HTMLInputElement>(`Amount of step ${label}`);
    const unit = within(step).getByRole<HTMLInputElement>("radio", { checked: true });
    return `${label} ${kind.value} ${amount.value} ${unit.value}`;
  });
}

async function save() {
  await userEvent.click(screen.getByRole("button", { name: "Save workout" }));
}

function posted(calls: ReturnType<typeof fakeBuilderApi>, method = "POST") {
  return calls.find((call) => call.method === method)?.body as CustomSessionInput | undefined;
}

describe("WorkoutBuilderScreen", () => {
  // Thu 8 Oct 2026, 07:00 in London.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderNew();

    expect(screen.getByRole("heading", { name: "New workout" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading the workout builder" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(planResponseFixture());
    });
    renderNew();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Save workout" })).toBeInTheDocument();
  });

  it("says workouts need a plan and links to the goal instead of the form (plan missing)", async () => {
    fakeBuilderApi({ plan: { goal: null, plan: null } });
    renderNew();

    expect(await screen.findByText(errorMessages.plan_missing)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set goal" })).toHaveAttribute("href", "/plan/goal");
    expect(screen.queryByRole("button", { name: "Save workout" })).not.toBeInTheDocument();
  });

  it("starts on the day it was opened for with an easy 5 km and its summary", async () => {
    fakeBuilderApi();
    renderNew();

    const date = await screen.findByLabelText("Date");
    expect(date).toHaveValue("2026-10-10");
    expect(date).toHaveAttribute("min", "2026-10-08");
    expect(screen.getByRole("radio", { name: "Easy" })).toBeChecked();
    expect(stepValues()).toEqual(["1 run 5 km"]);
    expect(screen.getByLabelText("Zone of step 1")).toHaveDisplayValue("Easy · 5:45-6:20 /km");
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary).toHaveTextContent(/^5\.0 km·30:135:45-6:20 \/km easy$/);
  });

  it("starts today when the link has no date or a past one", async () => {
    fakeBuilderApi();
    renderNew("2026-10-01");

    expect(await screen.findByLabelText("Date")).toHaveValue("2026-10-08");
  });

  it("keeps the draft when a save crosses midnight and asks for a date from today on (midnight)", async () => {
    // 23:58 on Thu 8 Oct in London; the API's day has moved on by the time Save reaches it.
    vi.setSystemTime(new Date("2026-10-08T22:58:00Z"));
    const calls = fakeBuilderApi({ save: problem(400, ErrorCode.validation) });
    renderNew(null);
    expect(await screen.findByLabelText("Date")).toHaveValue("2026-10-08");
    await userEvent.click(screen.getByRole("radio", { name: "Tempo" }));
    await userEvent.type(screen.getByLabelText("Title"), "Late tempo");

    // 00:01 on Fri 9 Oct: the save re-renders the screen with the new today.
    vi.setSystemTime(new Date("2026-10-08T23:01:00Z"));
    await save();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.validation);
    expect(screen.getByLabelText("Title")).toHaveValue("Late tempo");
    expect(screen.getByRole("radio", { name: "Tempo" })).toBeChecked();
    expect(screen.getByLabelText("Date")).toHaveValue("2026-10-08");
    expect(screen.getByLabelText("Date")).toHaveAttribute("min", "2026-10-09");

    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a date from today on.");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("loads each type's preset while the steps are untouched (presets)", async () => {
    fakeBuilderApi();
    renderNew();
    await screen.findByLabelText("Date");

    await userEvent.click(screen.getByRole("radio", { name: "Tempo" }));
    expect(stepValues()).toEqual(["1 warmup 15 min", "2 work 20 min", "3 cooldown 10 min"]);
    expect(screen.getByLabelText("Zone of step 2")).toHaveDisplayValue("Threshold · 5:00-5:07 /km");
    expect(screen.getAllByText("Easy, no pace alert")).toHaveLength(2);

    await userEvent.click(screen.getByRole("radio", { name: "Intervals" }));
    expect(screen.getByLabelText("Times to repeat 2")).toHaveValue("5");
    expect(stepValues()).toEqual([
      "1 warmup 15 min",
      "2.1 work 1 km",
      "2.2 recovery 3 min",
      "3 cooldown 10 min",
    ]);
    expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent(
      "15 min easy, 5 x 1 km at 4:45-4:52 /km with 3 min jog, 10 min easy",
    );

    await userEvent.click(screen.getByRole("radio", { name: "Long run" }));
    expect(stepValues()).toEqual(["1 run 12 km"]);

    await userEvent.click(screen.getByRole("radio", { name: "Race practice" }));
    expect(stepValues()).toEqual(["1 warmup 15 min", "2 work 5 km", "3 cooldown 10 min"]);
    expect(screen.getByLabelText("Zone of step 2")).toHaveDisplayValue("Race · 4:54-4:58 /km");
  });

  it("reads preset distances as round miles for a runner in miles (unit conversion)", async () => {
    fakeBuilderApi({ me: milesMe });
    renderNew();
    await screen.findByLabelText("Date");

    expect(stepValues()).toEqual(["1 run 3 mi"]);
    await userEvent.click(screen.getByRole("radio", { name: "Long run" }));
    expect(stepValues()).toEqual(["1 run 7.5 mi"]);
    await userEvent.click(screen.getByRole("radio", { name: "Intervals" }));
    expect(stepValues()[1]).toBe("2.1 work 1000 m");
    expect(screen.getByLabelText("Zone of step 2.1")).toHaveDisplayValue(
      "Interval · 7:39-7:50 /mi",
    );
  });

  it("keeps the runner's steps when another type is chosen after a change", async () => {
    fakeBuilderApi();
    renderNew();
    const amount = await screen.findByLabelText("Amount of step 1");

    await userEvent.clear(amount);
    await userEvent.type(amount, "8");
    await userEvent.click(screen.getByRole("radio", { name: "Long run" }));

    expect(stepValues()).toEqual(["1 run 8 km"]);
  });

  it("saves the workout in meters and seconds and opens it in the builder's place", async () => {
    const calls = fakeBuilderApi();
    const { router } = renderNew("2026-10-10", { history: ["/"] });
    await userEvent.click(await screen.findByRole("radio", { name: "Tempo" }));
    await userEvent.type(screen.getByLabelText("Title"), "Cruise tempo");

    await save();

    expect(posted(calls)).toEqual({
      date: "2026-10-10",
      type: "tempo",
      title: "Cruise tempo",
      steps: [
        { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
        { kind: "work", zone: "threshold", distanceM: null, durationS: 1200 },
        { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
      ],
    });
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/plan/sessions/${custom.id}`),
    );
    // Replaced, not pushed: Back from the new workout skips the builder.
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("builds steps by time or distance at a zone, with repeats, and converts miles and meters (unit conversion)", async () => {
    const calls = fakeBuilderApi({ me: milesMe });
    renderNew();
    await screen.findByLabelText("Date");

    await userEvent.selectOptions(screen.getByLabelText("Kind of step 1"), "warmup");
    const first = screen.getByLabelText("Amount of step 1");
    await userEvent.clear(first);
    await userEvent.type(first, "1.5");
    await userEvent.click(screen.getByRole("button", { name: "Add repeat" }));
    await userEvent.clear(screen.getByLabelText("Times to repeat 2"));
    await userEvent.type(screen.getByLabelText("Times to repeat 2"), "6");
    await userEvent.selectOptions(screen.getByLabelText("Zone of step 2.1"), "repetition");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    const last = screen.getByLabelText("Amount of step 3");
    await userEvent.clear(last);
    await userEvent.type(last, "12");
    await save();

    expect(posted(calls)?.steps).toEqual([
      { kind: "warmup", zone: "easy", distanceM: 2414, durationS: null },
      {
        repeat: 6,
        steps: [
          { kind: "work", zone: "repetition", distanceM: 400, durationS: null },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 120 },
        ],
      },
      { kind: "run", zone: "easy", distanceM: null, durationS: 720 },
    ]);
  });

  it("switches a step between minutes, the runner's unit and meters", async () => {
    const calls = fakeBuilderApi();
    renderNew();
    const units = await screen.findByRole("group", { name: "Unit of step 1" });

    await userEvent.click(within(units).getByRole("radio", { name: "m" }));
    const amount = screen.getByLabelText("Amount of step 1");
    await userEvent.clear(amount);
    await userEvent.type(amount, "800");
    await save();

    expect(posted(calls)?.steps).toEqual([
      { kind: "run", zone: "easy", distanceM: 800, durationS: null },
    ]);
  });

  it("removes steps, a repeat's rep and a repeat, never a repeat's last rep", async () => {
    fakeBuilderApi();
    renderNew();
    await userEvent.click(await screen.findByRole("radio", { name: "Intervals" }));

    await userEvent.click(screen.getByRole("button", { name: "Remove step 2.2" }));
    expect(screen.getByRole("button", { name: "Remove step 2.1" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Add step to repeat 2" }));
    expect(stepValues()).toEqual([
      "1 warmup 15 min",
      "2.1 work 1 km",
      "2.2 work 400 m",
      "3 cooldown 10 min",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Remove repeat 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove step 1" }));

    expect(stepValues()).toEqual(["1 cooldown 10 min"]);
  });

  it("names the step to fix and sends nothing while an amount is missing", async () => {
    const calls = fakeBuilderApi();
    renderNew();
    await userEvent.click(await screen.findByRole("radio", { name: "Intervals" }));
    await userEvent.clear(screen.getByLabelText("Amount of step 2.2"));

    expect(screen.queryByRole("region", { name: "Summary" })).not.toBeInTheDocument();
    await save();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter how long step 2.2 lasts, a number above zero.",
    );
    expect(posted(calls)).toBeUndefined();
  });

  it("keeps a repeat between 2 and 50 times", async () => {
    const calls = fakeBuilderApi();
    renderNew();
    await userEvent.click(await screen.findByRole("radio", { name: "Intervals" }));
    await userEvent.clear(screen.getByLabelText("Times to repeat 2"));
    await userEvent.type(screen.getByLabelText("Times to repeat 2"), "1");
    await save();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Repeat 2 runs 2 to 50 times. Change its count.",
    );
    expect(posted(calls)).toBeUndefined();
  });

  it("refuses a workout with more steps than the watch holds (step cap)", async () => {
    const calls = fakeBuilderApi();
    renderNew();
    const add = await screen.findByRole("button", { name: "Add step" });
    for (let step = 0; step < GARMIN_WORKOUT_STEPS_MAX; step += 1) await userEvent.click(add);
    await save();

    expect(screen.getByRole("alert")).toHaveTextContent(
      `This workout has ${GARMIN_WORKOUT_STEPS_MAX + 1} steps and a watch workout holds ${GARMIN_WORKOUT_STEPS_MAX}`,
    );
    expect(posted(calls)).toBeUndefined();
  });

  it("explains a save the API refuses for want of a plan and keeps the form (plan missing)", async () => {
    fakeBuilderApi({ save: problem(409, ErrorCode.planMissing) });
    const { router } = renderNew();
    await screen.findByLabelText("Date");

    await save();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.plan_missing);
    expect(router.state.location.pathname).toBe("/plan/sessions/new");
    expect(screen.getByRole("button", { name: "Save workout" })).toBeEnabled();
  });

  it("opens a custom workout with its date, type, title and steps, and puts the change back", async () => {
    const calls = fakeBuilderApi();
    const { router } = renderEdit(custom.id, [`/plan/sessions/${custom.id}`]);

    expect(screen.getByRole("heading", { name: "Edit workout" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Date")).toHaveValue("2026-10-09");
    expect(screen.getByRole("radio", { name: "Tempo" })).toBeChecked();
    expect(screen.getByLabelText("Title")).toHaveValue("Hill reps");
    expect(stepValues()).toEqual([
      "1 warmup 15 min",
      "2.1 work 400 m",
      "2.2 recovery 2 min",
      "3 cooldown 10 min",
    ]);
    // Its own steps stay when the type changes: they were the runner's from the start.
    await userEvent.click(screen.getByRole("radio", { name: "Intervals" }));
    expect(stepValues()).toHaveLength(4);
    await save();

    expect(calls.find((call) => call.method === "PUT")?.path).toBe(`/api/sessions/${custom.id}`);
    expect(posted(calls, "PUT")).toMatchObject({ type: "intervals", title: "Hill reps" });
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/plan/sessions/${custom.id}`),
    );
  });

  it("does not edit a plan session, and links to it instead", async () => {
    const intervals = planSessionFixture("2026-10-08");
    fakeBuilderApi({ detail: sessionDetailFixture({ session: intervals }) });
    renderEdit(intervals.id);

    expect(await screen.findByText(/^Only workouts you built can be edited\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open session" })).toHaveAttribute(
      "href",
      `/plan/sessions/${intervals.id}`,
    );
    expect(screen.queryByRole("button", { name: "Save workout" })).not.toBeInTheDocument();
  });

  it("does not edit a workout that is past or skipped (missed or moved session)", async () => {
    const skipped = customSessionFixture({ status: "skipped" });
    fakeBuilderApi({ detail: sessionDetailFixture({ session: skipped }) });
    renderEdit(skipped.id);

    expect(await screen.findByText(errorMessages.session_locked)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save workout" })).not.toBeInTheDocument();
  });
});
