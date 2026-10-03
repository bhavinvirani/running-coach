import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TextField } from "./text-field";

describe("TextField", () => {
  it("labels its input and describes it with the caption under it", async () => {
    const onChange = vi.fn();
    render(<TextField label="Title" description="Optional." value="" onChange={onChange} />);

    const input = screen.getByLabelText("Title");
    expect(input).toHaveAccessibleDescription("Optional.");
    await userEvent.type(input, "H");
    expect(onChange).toHaveBeenCalled();
  });

  it("has no description without a caption", () => {
    render(<TextField label="Date" type="date" defaultValue="2026-10-08" />);

    expect(screen.getByLabelText("Date")).not.toHaveAttribute("aria-describedby");
  });
});
