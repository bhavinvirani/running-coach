import { ErrorCode } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { errorMessages, versionMismatchMessage } from "@/lib/errors";
import { AppUpdatesContext } from "./app-update";
import { ScreenErrorBoundary } from "./screen-error-boundary";

function renderFailing(error: Error) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const loader = vi.fn(() => {
    throw error;
  });
  const router = createMemoryRouter([
    { path: "/", loader, ErrorBoundary: ScreenErrorBoundary, Component: () => <h1>Today</h1> },
  ]);
  const appUpdates = { versionMismatch: vi.fn() };
  render(
    <AppUpdatesContext value={appUpdates}>
      <RouterProvider router={router} />
    </AppUpdatesContext>,
  );
  return { loader, appUpdates };
}

describe("ScreenErrorBoundary", () => {
  it("offers Reload for an answer this version cannot read and tells app-update the screen is gone", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const { appUpdates } = renderFailing(
      new ApiError({ status: 200, code: ErrorCode.internal, contractMismatch: "read" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(versionMismatchMessage);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    // It reports from an effect, which a busy machine can run after the alert is on screen.
    await vi.waitFor(() => expect(appUpdates.versionMismatch).toHaveBeenCalledWith(true));
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps Retry, which reruns the loader, for any other error, and reports nothing", async () => {
    const { loader, appUpdates } = renderFailing(
      new ApiError({ status: 500, code: ErrorCode.internal }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(appUpdates.versionMismatch).not.toHaveBeenCalled();
  });
});
