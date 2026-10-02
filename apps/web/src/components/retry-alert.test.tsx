import { ErrorCode } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { errorMessages } from "@/lib/errors";
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

  it("runs the action again on Retry", async () => {
    const onRetry = vi.fn();
    render(<RetryAlert error={new Error("boom")} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
