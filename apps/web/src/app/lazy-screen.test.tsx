import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";
import { networkErrorMessage, versionMismatchMessage } from "@/lib/errors";
import { AppUpdatesContext } from "./app-update";
import { lazyScreen, ScreenLoadError } from "./lazy-screen";
import { ScreenErrorBoundary } from "./screen-error-boundary";

const gone = () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/plan-old.js"));

function Shell() {
  return (
    <>
      <Outlet />
      <nav aria-label="Tabs">
        <Link to="/">Today</Link>
        <Link to="/plan">Plan</Link>
      </nav>
    </>
  );
}

/** The app's route tree in small: a root with the waking screen, the tab shell, and a lazy Plan. */
function appLike(lazy: { Component: () => Promise<React.ComponentType> }) {
  return [
    {
      id: "root",
      HydrateFallback: () => <p>Waking</p>,
      ErrorBoundary: ScreenErrorBoundary,
      children: [
        {
          Component: Shell,
          ErrorBoundary: ScreenErrorBoundary,
          children: [
            { path: "/", Component: () => <h1>Today</h1> },
            { path: "/plan", ErrorBoundary: ScreenErrorBoundary, lazy },
          ],
        },
      ],
    },
  ];
}

function renderRoutes(initial: string, planScreen: () => Promise<React.ComponentType>) {
  const router = createMemoryRouter(appLike({ Component: lazyScreen(planScreen) }), {
    initialEntries: [initial],
  });
  const onError = vi.fn();
  const appUpdates = { versionMismatch: vi.fn() };
  render(
    <AppUpdatesContext value={appUpdates}>
      <RouterProvider router={router} onError={onError} />
    </AppUpdatesContext>,
  );
  return { router, onError, appUpdates };
}

describe("lazyScreen", () => {
  it("renders the screen when its code loads", async () => {
    renderRoutes("/plan", () => Promise.resolve(() => <h1>Plan</h1>));
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
  });

  it("shows the route's error inside the tabs, at the address asked for, when a screen's code is gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { router, onError, appUpdates } = renderRoutes("/", gone);
    await userEvent.click(await screen.findByRole("link", { name: "Plan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(versionMismatchMessage);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Tabs" })).getByRole("link", { name: "Plan" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/plan");
    const [[reported]] = onError.mock.calls as [[Error]];
    expect(reported).toBeInstanceOf(ScreenLoadError);
    expect(reported.cause).toBeInstanceOf(TypeError);
    // The screen is gone: app-update.ts may reload into the server's version. The boundary reports from an
    // effect, which a busy machine can run after the alert is on screen.
    await vi.waitFor(() => expect(appUpdates.versionMismatch).toHaveBeenCalledWith(true));
  });

  it("shows the route's error when the first screen of the app does not load, never a blank page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderRoutes("/plan", gone);
    expect(await screen.findByRole("alert")).toHaveTextContent(versionMismatchMessage);
    expect(screen.getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();
  });

  it("keeps saying the connection failed once the device is back online, since the failure stays for the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const load = vi.fn(gone);
    renderRoutes("/", load);
    await userEvent.click(await screen.findByRole("link", { name: "Plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(networkErrorMessage);

    onLine.mockReturnValue(true);
    await userEvent.click(screen.getByRole("link", { name: "Today" }));
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Plan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(networkErrorMessage);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // React Router never imports the screen again in this page: the second visit shows the first failure.
    expect(load).toHaveBeenCalledOnce();
  });

  it("reloads the page on Reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderRoutes("/plan", gone);
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("is needed: React Router renders a blank app for a lazy Component that rejects", async () => {
    const router = createMemoryRouter(appLike({ Component: gone }), { initialEntries: ["/"] });
    const { container } = render(<RouterProvider router={router} />);
    await userEvent.click(await screen.findByRole("link", { name: "Plan" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
    expect(router.state.errors).toBeNull();
  });
});
