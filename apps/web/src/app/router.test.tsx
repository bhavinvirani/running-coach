import { ErrorCode, type MeResponse } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorMessages, unreadWriteMessage, versionMismatchMessage } from "@/lib/errors";
import { json, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import {
  activityDetailFixture,
  activityFixture,
  activityResponseFixture,
  calendarFixture,
  customSessionFixture,
  importProgressFixture,
  meFixture,
  planResponseFixture,
  planSessionId,
  sessionDetailFixture,
  weekFixture,
} from "@/test/fixtures";
import { testQueryClient } from "@/test/render";
import { appRoutes } from "./router";
import { backgroundAndReturn, settle } from "@/test/lifecycle";

function renderApp(path: string) {
  const queryClient = testQueryClient();
  const router = createMemoryRouter(appRoutes(queryClient), { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/**
 * The API for a signed-in runner with one stored run, a finished import and a plan, who synced a moment
 * ago, so opening the app sends no sync: that has its own test below.
 */
function signedIn({ path, query }: FakeRequest): Response {
  if (path === "/api/me") {
    return json(meFixture({ garmin: { status: "ok", lastSyncAt: new Date().toISOString() } }));
  }
  if (path === "/api/activities/latest") return json({ activity: activityFixture() });
  if (path === `/api/activities/${activityFixture().id}`) {
    return json(activityResponseFixture({ detail: activityDetailFixture() }));
  }
  if (path === "/api/activities") {
    return json({ weeks: [weekFixture("2026-09-21", [activityFixture()])], nextBefore: null });
  }
  if (path === "/api/plan") return json(planResponseFixture());
  if (path === "/api/calendar") return json(calendarFixture(query.get("from") ?? "2026-10-05"));
  if (path === `/api/sessions/${planSessionId("2026-10-08")}`) return json(sessionDetailFixture());
  if (path === `/api/sessions/${customSessionFixture().id}`) {
    return json(sessionDetailFixture({ session: customSessionFixture() }));
  }
  if (path === "/api/import") {
    return json(
      importProgressFixture({ status: "done", runsStored: 1, finishedAt: "2026-09-27T06:20:00Z" }),
    );
  }
  return notFound();
}

/** Boot retries back off with jitter; at zero they run at once, so a test never sleeps. */
function retryWithoutWaiting() {
  vi.spyOn(Math, "random").mockReturnValue(0);
}

describe("app routes", () => {
  beforeEach(() => {
    // The sync on open records this device's attempt there.
    localStorage.clear();
  });

  it("sends a visitor without a session to the login screen without retrying the 401", async () => {
    const calls = stubFetch(() => problem(401, ErrorCode.unauthorized));
    const router = renderApp("/settings");
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(calls.filter((call) => call.path === "/api/me")).toHaveLength(1);
  });

  it("offers Reload, not Retry, when /api/me answers in a shape this version cannot read, and asks once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const me = meFixture();
    // A coach detail this version does not know, as a newer API would send it.
    const calls = stubFetch(() =>
      json({ ...me, settings: { ...me.settings, coachDetail: "brief" } }),
    );
    renderApp("/");
    expect(await screen.findByRole("alert")).toHaveTextContent(versionMismatchMessage);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(calls.filter((call) => call.path === "/api/me")).toHaveLength(1);
  });

  it("shows a screen whose first load this version cannot read as the route's error inside the tabs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const plan = planResponseFixture();
    const unreadable = structuredClone(plan) as unknown as {
      plan: { weeks: { sessions: { status: string }[] }[] };
    };
    unreadable.plan.weeks[0]!.sessions[0]!.status = "archived";
    const calls = stubFetch((request) =>
      request.path === "/api/plan" ? json(unreadable) : signedIn(request),
    );
    renderApp("/plan");
    expect(await screen.findByRole("alert")).toHaveTextContent(versionMismatchMessage);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();
    expect(calls.filter((call) => call.path === "/api/plan")).toHaveLength(1);
  });

  it("opens Today at / inside the tab shell, as the first and selected tab", async () => {
    stubFetch(signedIn);
    const router = renderApp("/");
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");

    const tabs = within(screen.getByRole("navigation", { name: "Tabs" })).getAllByRole("link");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Today", "Plan", "Progress", "Settings"]);
    expect(tabs[0]).toHaveAttribute("aria-current", "page");
    expect(tabs[0]).toHaveClass("text-accent");
    for (const tab of tabs.slice(1)) expect(tab).not.toHaveAttribute("aria-current");
  });

  it("opens Plan on /plan inside the tab shell, between Today and Progress, and selects only its tab", async () => {
    stubFetch(signedIn);
    renderApp("/plan");
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Goal" })).toBeInTheDocument();
    const plan = screen.getByRole("link", { name: "Plan" });
    expect(plan).toHaveAttribute("href", "/plan");
    expect(plan).toHaveAttribute("aria-current", "page");
    for (const name of ["Today", "Progress", "Settings"]) {
      expect(screen.getByRole("link", { name })).not.toHaveAttribute("aria-current");
    }
  });

  it("opens a week from its Plan card inside the tab shell, with Plan still selected, and Back returns", async () => {
    stubFetch(signedIn);
    const router = renderApp("/plan");
    const weeks = await screen.findByRole("region", { name: "Weeks" });

    await userEvent.click(within(weeks).getAllByRole("link")[1]!);

    expect(await screen.findByRole("heading", { name: "Week 2" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plan/weeks/2");
    expect(screen.getByRole("link", { name: "Plan" })).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("link", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plan");
  });

  it("opens the goal form from Change goal, inside the tab shell", async () => {
    stubFetch(signedIn);
    const router = renderApp("/plan");

    await userEvent.click(await screen.findByRole("link", { name: "Change goal" }));

    // Level 1: the Plan screen's goal card has a "Goal" heading of its own.
    expect(await screen.findByRole("heading", { name: "Goal", level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plan/goal");
    expect(await screen.findByRole("button", { name: "Save goal" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();
  });

  it("opens a session from its week row inside the tab shell, and Back returns to the week", async () => {
    stubFetch(signedIn);
    const router = renderApp("/plan/weeks/1");
    const days = await screen.findByRole("region", { name: "Days" });

    await userEvent.click(within(days).getByRole("link", { name: /^Intervals, Thu 8 Oct/ }));

    expect(await screen.findByRole("heading", { name: "Thu 8 Oct" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/plan/sessions/${planSessionId("2026-10-08")}`);
    expect(screen.getByRole("link", { name: "Plan" })).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("link", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Week 1" })).toBeInTheDocument();
  });

  it("opens the workout builder at /plan/sessions/new, not as a session id, inside the tab shell", async () => {
    stubFetch(signedIn);
    renderApp("/plan/sessions/new?date=2026-10-10");

    expect(await screen.findByRole("heading", { name: "New workout" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Save workout" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();
  });

  it("opens a custom workout in the builder at /plan/sessions/:id/edit", async () => {
    stubFetch(signedIn);
    renderApp(`/plan/sessions/${customSessionFixture().id}/edit`);

    expect(await screen.findByRole("heading", { name: "Edit workout" })).toBeInTheDocument();
  });

  it("opens Progress on /progress inside the tab shell and selects only its tab", async () => {
    stubFetch(signedIn);
    renderApp("/progress");
    expect(await screen.findByRole("heading", { name: "Progress" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Progress" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Plan" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
  });

  it("moves from Today to Progress with its tab", async () => {
    stubFetch(signedIn);
    const router = renderApp("/");
    await screen.findByRole("heading", { name: "Today" });

    await userEvent.click(screen.getByRole("link", { name: "Progress" }));

    expect(await screen.findByRole("heading", { name: "Progress" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/progress");
  });

  it("selects only the Settings tab on /settings", async () => {
    stubFetch(signedIn);
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Plan" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Progress" })).not.toHaveAttribute("aria-current");
  });

  it("opens a run from its Progress row inside the tab shell, and Back returns to Progress", async () => {
    stubFetch(signedIn);
    const router = renderApp("/progress");
    const week = await screen.findByRole("region", { name: "21–27 Sep" });

    await userEvent.click(within(week).getByRole("link"));

    expect(await screen.findByRole("heading", { name: "Sun 27 Sep" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/runs/${activityFixture().id}`);
    expect(screen.getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Progress" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/progress");
  });

  it("redirects an unknown path to Today", async () => {
    stubFetch(signedIn);
    const router = renderApp("/nowhere");
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("shows the error boundary with Retry when the first load fails, and recovers", async () => {
    retryWithoutWaiting();
    let failing = true;
    stubFetch((request) => (failing ? problem(500, ErrorCode.internal) : signedIn(request)));
    renderApp("/settings");

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("rides out the server waking, past the usual three retries, then opens Today (cold start)", async () => {
    retryWithoutWaiting();
    // What a sleeping Render instance answers: no answer, its proxy's 502 to 504, before the API is up.
    const waking = [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => problem(503, ErrorCode.internal),
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
      () => new Response("<html>Gateway timeout</html>", { status: 504 }),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ];
    const calls = stubFetch((request) => {
      const answer = request.path === "/api/me" ? waking.shift() : undefined;
      return answer ? answer() : signedIn(request);
    });
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(calls.filter((call) => call.path === "/api/me")).toHaveLength(6);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("syncs once when the app opens on any tab, and not again on a tab change (sync on open)", async () => {
    const calls = stubFetch((request) => {
      if (request.path === "/api/me") {
        const anHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
        return json(meFixture({ garmin: { status: "ok", lastSyncAt: anHourAgo } }));
      }
      if (request.method === "POST" && request.path === "/api/sync") {
        return json({
          lastSyncAt: new Date().toISOString(),
          activitiesWritten: 0,
          activitiesRemoved: 0,
        });
      }
      return signedIn(request);
    });
    const syncs = () => calls.filter((call) => call.path === "/api/sync");
    renderApp("/settings");

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    await vi.waitFor(() => expect(syncs()).toHaveLength(1));
    expect(syncs()[0]).toMatchObject({ method: "POST", body: undefined });

    await userEvent.click(screen.getByRole("link", { name: "Today" }));
    expect(await screen.findByText("No new runs on Garmin.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Progress" }));
    expect(await screen.findByRole("heading", { name: "Progress" })).toBeInTheDocument();

    expect(syncs()).toHaveLength(1);
  });

  it("keeps the screen, its tabs and what is typed when the sync on open gets an answer this version cannot read", async () => {
    const calls = stubFetch((request) => {
      if (request.path === "/api/me") {
        const anHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
        return json(meFixture({ garmin: { status: "ok", lastSyncAt: anHourAgo } }));
      }
      if (request.method === "POST" && request.path === "/api/sync") {
        // A field renamed by a newer API: this version cannot read the answer.
        return json({ lastSyncAt: new Date().toISOString(), runsWritten: 0, activitiesRemoved: 0 });
      }
      return signedIn(request);
    });
    renderApp("/plan/goal");
    const raceDate = await screen.findByLabelText("Race date");
    await userEvent.clear(raceDate);
    await userEvent.type(raceDate, "2027-04-18");
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.path === "/api/sync")).toHaveLength(1),
    );
    await settle();

    expect(screen.getByLabelText("Race date")).toHaveValue("2027-04-18");
    expect(screen.getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Today" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(unreadWriteMessage);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it.each([
    { corner: "on Today", leaveToday: false },
    { corner: "Today left for Settings and back", leaveToday: true },
  ])(
    "shows Sync now and no stale login error after a reconnect, once the open sync's rejection marked the login expired (expired login, reconnected, $corner)",
    async ({ leaveToday }) => {
      const anHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      let garmin: MeResponse["garmin"] = { status: "ok", lastSyncAt: anHourAgo };
      const calls = stubFetch((request) => {
        if (request.path === "/api/me") return json(meFixture({ garmin }));
        if (request.method === "POST" && request.path === "/api/sync") {
          // The second rejection in a row: the API marks the login expired.
          garmin = { status: "expired", lastSyncAt: anHourAgo };
          return problem(409, ErrorCode.garminAuthExpired);
        }
        return signedIn(request);
      });
      renderApp("/");
      const reconnect = await screen.findByRole("link", { name: "Reconnect Garmin" });
      if (leaveToday) {
        await userEvent.click(reconnect);
        expect(await screen.findByText("Login expired")).toBeInTheDocument();
      }

      // Reconnected from the laptop; back in the foreground the app reads /api/me again.
      garmin = { status: "ok", lastSyncAt: anHourAgo };
      backgroundAndReturn();
      if (leaveToday) {
        expect(await screen.findByText("Connected")).toBeInTheDocument();
        await userEvent.click(screen.getByRole("link", { name: "Today" }));
      }

      expect(await screen.findByRole("button", { name: "Sync now" })).toBeEnabled();
      await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
      expect(screen.queryByText(errorMessages.garmin_auth_expired)).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Reconnect Garmin" })).not.toBeInTheDocument();
      // The open sync's attempt is under 10 minutes old, so the foreground only reads /api/me.
      expect(calls.filter((call) => call.path === "/api/sync")).toHaveLength(1);
    },
  );
});
