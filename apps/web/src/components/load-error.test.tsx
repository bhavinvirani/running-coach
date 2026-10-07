import { ErrorCode } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { errorMessages } from "@/lib/errors";
import { LoadError } from "./load-error";

describe("LoadError", () => {
  it("says what failed in ink with role alert and loads again on Retry", async () => {
    const onRetry = vi.fn();
    render(
      <LoadError
        error={new ApiError({ status: 500, code: ErrorCode.internal })}
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
