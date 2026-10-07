import type { MeResponse, PlanResponse, PlanSession, TrainingPause } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planKey } from "@/api/plan";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import {
  coachEasySessionFixture,
  coachRestSessionFixture,
  customSessionFixture,
  doneSessionFixture,
  easedSessionFixture,
  meFixture,
  missedSessionFixture,
  pauseSkippedSessionFixture,
  pausedSessionFixture,
  planFixture,
  planResponseFixture,
  planSessionId,
  trainingPauseFixture,
  walkRunSessionFixture,
} from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { PlanWeekScreen } from "./plan-week-screen";

function fakePlanApi({
  me = meFixture(),
  plan = planResponseFixture(),
  pause = null,
}: {
  me?: MeResponse;
  plan?: PlanResponse;
  /** GET /api/pause: the open pause (none by default), or an answer that never comes or fails. */
  pause?: TrainingPause | null | (() => Response | Promise<Response>);
} = {}) {
  return stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/plan") return json(plan);
    if (method === "GET" && path === "/api/pause") {
      return typeof pause === "function" ? pause() : json({ pause });
    }
    return notFound();
  });
}

/** Where each day's Add leads, null for a day without one, Monday first. */
function addLinks(rows: HTMLElement[]) {
  return rows.map(
    (row) =>
      within(row)
        .queryByRole("link", { name: /^Add a workout on / })
        ?.getAttribute("href") ?? null,
  );
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
  // After race day, so no day takes Add unless a test moves the clock back into the plan.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
      if (path === "/api/pause") return json({ pause: null });
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
      if (path === "/api/pause") return json({ pause: null });
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

  it("opens each session's screen from its row", async () => {
    fakePlanApi();
    const { router } = renderWeek(1);

    const rows = await dayRows();
    const intervals = within(rows[3]!).getByRole("link", {
      name: "Intervals, Thu 8 Oct, 11.6 km, 1:04:00",
    });
    expect(intervals).toHaveAttribute("href", `/plan/sessions/${planSessionId("2026-10-08")}`);
    expect(within(rows[0]!).queryByRole("link")).not.toBeInTheDocument();

    await userEvent.click(intervals);
    expect(router.state.location.pathname).toBe(`/plan/sessions/${planSessionId("2026-10-08")}`);
  });

  it("offers Add on the days from today on, opening the builder on that date", async () => {
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
    fakePlanApi();
    renderWeek(1);

    const rows = await dayRows();
    // Add waits for the pause read, which says from which day the API refuses one.
    await screen.findAllByRole("link", { name: /^Add a workout on / });
    expect(addLinks(rows)).toEqual([
      null,
      null,
      null,
      "/plan/sessions/new?date=2026-10-08",
      "/plan/sessions/new?date=2026-10-09",
      "/plan/sessions/new?date=2026-10-10",
      "/plan/sessions/new?date=2026-10-11",
    ]);
    expect(
      within(rows[5]!).getByRole("link", { name: "Add a workout on Sat 10 Oct" }),
    ).toHaveTextContent(/^Add$/);
  });

  it("offers no Add from an open pause's start on, which the API refuses (no add in pause)", async () => {
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
    // Paused from Fri 9 Oct, a day after today as a runner who flew west sees it: Thu 8 still takes Add.
    fakePlanApi({ pause: trainingPauseFixture({ startDate: "2026-10-09" }) });
    renderWeek(1);

    const rows = await dayRows();
    await screen.findAllByRole("link", { name: /^Add a workout on / });
    expect(addLinks(rows)).toEqual([
      null,
      null,
      null,
      "/plan/sessions/new?date=2026-10-08",
      null,
      null,
      null,
    ]);
  });

  it("offers no Add until the pause is read, and every day's from today on once there is none (pause loading)", async () => {
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
    let answer: (response: Response) => void = () => undefined;
    const pause = new Promise<Response>((resolve) => (answer = resolve));
    fakePlanApi({ pause: () => pause });
    renderWeek(1);

    const rows = await dayRows();
    expect(addLinks(rows)).toEqual([null, null, null, null, null, null, null]);
    act(() => answer(json({ pause: null })));

    expect(
      await screen.findByRole("link", { name: "Add a workout on Thu 8 Oct" }),
    ).toBeInTheDocument();
    expect(addLinks(rows).filter((href) => href !== null)).toHaveLength(4);
  });

  it("offers Add from today on when the pause could not be read, as the API still refuses one in a pause (pause load error)", async () => {
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
    fakePlanApi({ pause: () => problem(500, ErrorCode.internal) });
    renderWeek(1);

    const rows = await dayRows();
    await screen.findAllByRole("link", { name: /^Add a workout on / });
    expect(addLinks(rows).filter((href) => href !== null)).toHaveLength(4);
  });

  it("never asks for the pause without a plan (no plan)", async () => {
    const calls = fakePlanApi({ plan: { goal: null, plan: null } });
    renderWeek(1);

    expect(await screen.findByText("You have no plan yet.")).toBeInTheDocument();
    expect(calls.some((call) => call.path === "/api/pause")).toBe(false);
  });

  it("names a custom workout by its title and reads a skipped session as Skipped, without distance or steps", async () => {
    const plan = planFixture();
    const [first, ...rest] = plan.weeks;
    const week = {
      ...first!,
      sessions: [
        ...first!.sessions.map((session) =>
          session.date === "2026-10-09" ? { ...session, status: "skipped" as const } : session,
        ),
        customSessionFixture(),
      ],
    };
    fakePlanApi({ plan: planResponseFixture({ plan: { ...plan, weeks: [week, ...rest] } }) });
    renderWeek(1);

    const rows = await dayRows();
    const [skipped, custom] = within(rows[4]!).getAllByRole("link");
    expect(skipped).toHaveAccessibleName("Easy, Fri 9 Oct, Skipped");
    expect(skipped).toHaveTextContent(/^EasySkipped$/);
    expect(skipped!.firstElementChild).toHaveClass("text-ink-2");
    expect(custom).toHaveAccessibleName("Hill reps, Tempo, Fri 9 Oct, 7.1 km, 41:04");
    expect(within(custom!).getByText("Hill reps").querySelector("span")).toHaveClass(
      "bg-type-tempo",
    );
    expect(custom).toHaveTextContent(
      "Tempo · 15 min easy, 4 x 400 m at 5:00-5:07 /km with 2 min jog, 10 min easy",
    );
  });

  it("names the type of a titled custom workout beside its type colour, untitled ones by the type alone (type name)", async () => {
    const plan = planFixture();
    const [first, ...rest] = plan.weeks;
    const week = {
      ...first!,
      sessions: [
        ...first!.sessions,
        customSessionFixture({ id: "c0ffee00-0000-4000-8000-000000000002", status: "skipped" }),
        customSessionFixture({
          id: "c0ffee00-0000-4000-8000-000000000003",
          date: "2026-10-10",
          type: "long",
          title: null,
        }),
      ],
    };
    fakePlanApi({ plan: planResponseFixture({ plan: { ...plan, weeks: [week, ...rest] } }) });
    renderWeek(1);

    const rows = await dayRows();
    const skipped = within(rows[4]!).getByRole("link", { name: /^Hill reps,/ });
    expect(skipped).toHaveAccessibleName("Hill reps, Tempo, Fri 9 Oct, Skipped");
    expect(within(skipped).getByText("Tempo")).toHaveClass("text-ink-2");
    const untitled = within(rows[5]!).getByRole("link", { name: /^Long run, Sat 10 Oct/ });
    expect(untitled).toHaveAccessibleName("Long run, Sat 10 Oct, 7.1 km, 41:04");
    expect(within(untitled).getAllByText(/Long run/)).toHaveLength(1);
  });

  it("reads a done, missed or paused session as such beside its distance and time (session status)", async () => {
    fakePlanApi({
      plan: withSessions([
        doneSessionFixture("2026-10-06"),
        missedSessionFixture("2026-10-07"),
        pausedSessionFixture("2026-10-09"),
      ]),
    });
    renderWeek(1);

    const rows = await dayRows();
    const done = within(rows[1]!).getByRole("link");
    expect(done).toHaveAccessibleName("Easy, Tue 6 Oct, Done, 7.5 km, 45:00");
    expect(done).toHaveAttribute("href", `/plan/sessions/${planSessionId("2026-10-06")}`);
    expect(within(rows[2]!).getByRole("link")).toHaveAccessibleName(
      "Strength, Wed 7 Oct, Missed, 30:00",
    );
    expect(within(rows[4]!).getByRole("link")).toHaveAccessibleName(
      "Easy, Fri 9 Oct, Paused, 5.0 km, 30:00",
    );
    expect(rows[4]).toHaveTextContent(/^Fri 9 OctEasyPaused5\.0 km30:00/);
  });

  it("says what a session the coach or a return changed was, on a line under its steps (adjusted session)", async () => {
    fakePlanApi({
      plan: withSessions([
        coachEasySessionFixture(),
        coachRestSessionFixture(),
        easedSessionFixture("pause"),
      ]),
    });
    renderWeek(1);

    const rows = await dayRows();
    const coach = within(rows[3]!).getByRole("link");
    expect(coach).toHaveAccessibleName(
      "Easy, Thu 8 Oct, 10.6 km, 1:04:00, Changed by the coach, was Intervals 11.6 km",
    );
    expect(within(coach).getByText("Changed by the coach, was Intervals 11.6 km")).toHaveClass(
      "text-caption",
      "text-ink-2",
    );
    // A coach rest says it was skipped once, in its own words.
    const rest = within(rows[4]!).getByRole("link");
    expect(rest).toHaveAccessibleName("Easy, Fri 9 Oct, Skipped by the coach");
    expect(rest).toHaveTextContent(/^EasySkipped by the coach$/);
    expect(within(rows[6]!).getByRole("link")).toHaveAccessibleName(
      "Long run, Sun 11 Oct, 9.8 km, 59:09, Eased for your return, was 14.0 km",
    );
  });

  it("says a session left in the pause was skipped during it, in one line (pause rest)", async () => {
    fakePlanApi({ plan: withSessions([pauseSkippedSessionFixture("2026-10-09")]) });
    renderWeek(1);

    const rows = await dayRows();
    const skipped = within(rows[4]!).getByRole("link");
    expect(skipped).toHaveAccessibleName("Easy, Fri 9 Oct, Skipped during your pause");
    expect(skipped).toHaveTextContent(/^EasySkipped during your pause$/);
    expect(within(skipped).getByText("Skipped during your pause")).toHaveClass(
      "text-caption",
      "text-ink-2",
    );
  });

  it("reads a walk-run by its rounds with a walk between them, and says what it was (walk-run)", async () => {
    fakePlanApi({ plan: withSessions([walkRunSessionFixture("2026-10-09")]) });
    renderWeek(1);

    const rows = await dayRows();
    expect(within(rows[4]!).getByRole("link")).toHaveAccessibleName(
      "Walk-run, Easy, Fri 9 Oct, 5.0 km, 30:00, Walk-run for your return, was Easy 5.0 km",
    );
    expect(rows[4]).toHaveTextContent(
      /^Fri 9 OctWalk-run5\.0 km30:00Easy · 6 x 4 min easy with 1 min walkWalk-run for your return, was Easy 5\.0 km$/,
    );
  });

  it("gives what an eased session was in mi when the runner uses miles (unit conversion)", async () => {
    fakePlanApi({
      me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }),
      plan: withSessions([easedSessionFixture("gap")]),
    });
    renderWeek(1);

    const rows = await dayRows();
    expect(within(rows[6]!).getByText("Eased for your return, was 8.7 mi")).toBeInTheDocument();
  });
});

/** planResponseFixture with week 1's sessions on the dates of `sessions` replaced by them. */
function withSessions(sessions: PlanSession[]): PlanResponse {
  const plan = planFixture();
  const byDate = new Map(sessions.map((session) => [session.date, session]));
  const weeks = plan.weeks.map((week) =>
    week.number === 1
      ? {
          ...week,
          sessions: week.sessions.map((session) => byDate.get(session.date) ?? session),
        }
      : week,
  );
  return planResponseFixture({ plan: { ...plan, weeks } });
}
