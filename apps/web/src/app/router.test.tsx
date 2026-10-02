import { ErrorCode } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";
import { errorMessages } from "@/lib/errors";
import { json, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import { activityFixture, importProgressFixture, meFixture, weekFixture } from "@/test/fixtures";
import { testQueryClient } from "@/test/render";
import { appRoutes } from "./router";

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

/** The API for a signed-in runner with one stored run and a finished import. */
function signedIn({ path }: FakeRequest): Response {
  if (path === "/api/me") return json(meFixture());
  if (path === "/api/activities/latest") return json({ activity: activityFixture() });
  if (path === "/api/activities") {
    return json({ weeks: [weekFixture("2026-09-21", [activityFixture()])], nextBefore: null });
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
  it("sends a visitor without a session to the login screen without retrying the 401", async () => {
    const calls = stubFetch(() => problem(401, ErrorCode.unauthorized));
    const router = renderApp("/settings");
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(calls.filter((call) => call.path === "/api/me")).toHaveLength(1);
  });

  it("opens Today at / inside the tab shell, as the first and selected tab", async () => {
    stubFetch(signedIn);
    const router = renderApp("/");
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");

    const tabs = within(screen.getByRole("navigation", { name: "Tabs" })).getAllByRole("link");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Today", "Progress", "Settings"]);
    expect(tabs[0]).toHaveAttribute("aria-current", "page");
    expect(tabs[0]).toHaveClass("text-accent");
    expect(tabs[1]).not.toHaveAttribute("aria-current");
    expect(tabs[2]).not.toHaveAttribute("aria-current");
  });

  it("opens Progress on /progress inside the tab shell and selects only its tab", async () => {
    stubFetch(signedIn);
    renderApp("/progress");
    expect(await screen.findByRole("heading", { name: "Progress" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Progress" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute("aria-current");
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
    expect(screen.getByRole("link", { name: "Progress" })).not.toHaveAttribute("aria-current");
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
});
