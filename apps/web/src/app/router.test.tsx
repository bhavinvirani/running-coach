import { ErrorCode } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it } from "vitest";
import { errorMessages } from "@/lib/errors";
import { json, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
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

describe("app routes", () => {
  it("sends a visitor without a session to the login screen", async () => {
    stubFetch(() => problem(401, ErrorCode.unauthorized));
    const router = renderApp("/settings");
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("opens Settings from / inside the tab shell, with Settings as the selected tab", async () => {
    stubFetch(() => json(meFixture()));
    const router = renderApp("/");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");

    const tabs = screen.getByRole("navigation", { name: "Tabs" });
    const settingsTab = screen.getByRole("link", { name: "Settings" });
    expect(tabs).toContainElement(settingsTab);
    expect(settingsTab).toHaveAttribute("aria-current", "page");
    expect(settingsTab).toHaveClass("text-accent");
  });

  it("redirects an unknown path to the app", async () => {
    stubFetch(() => json(meFixture()));
    const router = renderApp("/nowhere");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("shows the error boundary with Retry when the first load fails, and recovers", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(503, ErrorCode.internal) : json(meFixture());
    });
    renderApp("/settings");

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});
