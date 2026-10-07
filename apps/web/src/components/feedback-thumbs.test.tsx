import { ErrorCode } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { errorMessages } from "@/lib/errors";
import { FeedbackThumbs } from "./feedback-thumbs";

describe("FeedbackThumbs", () => {
  it("names both thumbs in words, neither pressed without feedback", () => {
    render(<FeedbackThumbs feedback={null} onChange={() => {}} error={null} />);
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Not helpful" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("draws the pressed thumb like the app's other toggles, never in accent", () => {
    render(<FeedbackThumbs feedback="down" onChange={() => {}} error={null} />);
    const notHelpful = screen.getByRole("button", { name: "Not helpful" });
    expect(notHelpful).toHaveAttribute("aria-pressed", "true");
    expect(notHelpful).toHaveClass("bg-surface-2", "font-semibold", "text-ink");
    expect(notHelpful).not.toHaveClass("text-accent");
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveClass(
      "font-normal",
      "text-ink-2",
    );
  });

  it("sends the tapped thumb, and null when the pressed one is tapped again (clears it)", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FeedbackThumbs feedback={null} onChange={onChange} error={null} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Helpful" }));
    expect(onChange).toHaveBeenLastCalledWith("up");

    rerender(<FeedbackThumbs feedback="up" onChange={onChange} error={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Helpful" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByRole("button", { name: "Not helpful" }));
    expect(onChange).toHaveBeenLastCalledWith("down");
  });

  it("says why saving failed as an alert in text-ink", () => {
    render(
      <FeedbackThumbs
        feedback={null}
        onChange={() => {}}
        error={new ApiError({ status: 500, code: ErrorCode.internal })}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
  });
});
