import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";
import { versionMismatchMessage } from "@/lib/errors";
import { json, notFound, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { testQueryClient } from "@/test/render";
import { appRoutes } from "./router";

// Every screen's code is gone, as after a deploy that removed this version's files: a file of its own, since
// vi.mock holds for every test in a file. vi.mock runs before the imports, so its factory comes from
// vi.hoisted.
const { gone } = vi.hoisted(() => ({
  gone: () => {
    throw new TypeError("Failed to fetch dynamically imported module");
  },
}));
vi.mock("@/screens/login/login-screen", gone);
vi.mock("@/screens/today/today-screen", gone);
vi.mock("@/screens/plan/plan-screen", gone);
vi.mock("@/screens/goal/goal-screen", gone);
vi.mock("@/screens/plan-week/plan-week-screen", gone);
vi.mock("@/screens/reviews/reviews-screen", gone);
vi.mock("@/screens/review/review-screen", gone);
vi.mock("@/screens/workout-builder/workout-builder-screen", gone);
vi.mock("@/screens/session/session-screen", gone);
vi.mock("@/screens/progress/progress-screen", gone);
vi.mock("@/screens/run/run-screen", gone);
vi.mock("@/screens/settings/settings-screen", gone);
vi.mock("@/screens/garmin/garmin-screen", gone);
vi.mock("@/screens/claude/claude-screen", gone);
vi.mock("@/screens/units/units-screen", gone);
vi.mock("@/screens/coach-detail/coach-detail-screen", gone);
vi.mock("@/screens/hr-zones/hr-zones-screen", gone);
vi.mock("@/screens/shoes/shoes-screen", gone);
vi.mock("@/screens/shoe/shoe-screen", gone);

/** Every lazy route inside the tabs, and an address that opens it. */
const tabScreens = [
  { route: "/", at: "/" },
  { route: "/plan", at: "/plan" },
  { route: "/plan/goal", at: "/plan/goal" },
  { route: "/plan/weeks/:number", at: "/plan/weeks/1" },
  { route: "/plan/reviews", at: "/plan/reviews" },
  { route: "/plan/reviews/:id", at: "/plan/reviews/abc" },
  { route: "/plan/sessions/new", at: "/plan/sessions/new" },
  { route: "/plan/sessions/:id", at: "/plan/sessions/abc" },
  { route: "/plan/sessions/:id/edit", at: "/plan/sessions/abc/edit" },
  { route: "/progress", at: "/progress" },
  { route: "/runs/:id", at: "/runs/abc" },
  { route: "/settings", at: "/settings" },
  { route: "/settings/garmin", at: "/settings/garmin" },
  { route: "/settings/claude", at: "/settings/claude" },
  { route: "/settings/units", at: "/settings/units" },
  { route: "/settings/coach-detail", at: "/settings/coach-detail" },
  { route: "/settings/hr-zones", at: "/settings/hr-zones" },
  { route: "/settings/shoes", at: "/settings/shoes" },
  { route: "/settings/shoes/new", at: "/settings/shoes/new" },
  { route: "/settings/shoes/:id", at: "/settings/shoes/abc" },
];

/** A route's full pattern, from its parent's and its own path, as React Router nests them. */
function nested(parent: string, path: string | undefined): string {
  if (path === undefined) return parent;
  return path.startsWith("/") ? path : `${parent.replace(/\/$/, "")}/${path}`;
}

/** The pattern of every route in the tree that loads its screen with `lazy`. */
function lazyRoutes(routes: RouteObject[], parent = ""): string[] {
  return routes.flatMap((route) => {
    const pattern = nested(parent, route.path);
    return [...(route.lazy ? [pattern || "/"] : []), ...lazyRoutes(route.children ?? [], pattern)];
  });
}

function renderAt(path: string) {
  const queryClient = testQueryClient();
  const router = createMemoryRouter(appRoutes(queryClient), { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    router,
    /** The pattern of the deepest route the address opened. */
    opened: () =>
      router.state.matches.reduce((pattern, { route }) => nested(pattern, route.path), "") || "/",
  };
}

describe("a screen whose code is gone", () => {
  it("has a case below for every lazy route, so a new route needs one", () => {
    expect(lazyRoutes(appRoutes(testQueryClient())).sort()).toEqual(
      [...tabScreens.map(({ route }) => route), "/login"].sort(),
    );
  });

  it.each(tabScreens)(
    "shows $route's error inside the tabs, at $at, never a blank app",
    async ({ route, at }) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      // Synced a moment ago, so opening the app sends no sync.
      stubFetch(({ path }) =>
        path === "/api/me"
          ? json(meFixture({ garmin: { status: "ok", lastSyncAt: new Date().toISOString() } }))
          : notFound(),
      );
      const { router, opened } = renderAt(at);

      expect(await screen.findByRole("alert")).toHaveTextContent(versionMismatchMessage);
      expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(at);
      expect(opened()).toBe(route);
    },
  );

  it("shows the login screen's error at /login, never a blank app", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => notFound());
    const { router, opened } = renderAt("/login");

    expect(await screen.findByRole("alert")).toHaveTextContent(versionMismatchMessage);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(opened()).toBe("/login");
  });
});
