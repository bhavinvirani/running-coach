import { ErrorCode } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { errorMessages, versionMismatchMessage } from "@/lib/errors";
import { RetryAlert } from "./retry-alert";

describe("RetryAlert", () => {
  it("says what failed in text-ink as an alert", () => {
    render(
      <RetryAlert
        error={new ApiError({ status: 502, code: ErrorCode.garminUnavailable })}
        onRetry={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.garmin_unavailable);
    expect(alert).toHaveClass("text-body", "text-ink");
  });

  it("offers Reload instead of Retry for an answer this version cannot read, and reloads the page", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const onRetry = vi.fn();
    render(
      <RetryAlert
        error={new ApiError({ status: 200, code: ErrorCode.internal, contractMismatch: "read" })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(versionMismatchMessage);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("runs the action again on Retry", async () => {
    const onRetry = vi.fn();
    render(<RetryAlert error={new Error("boom")} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
