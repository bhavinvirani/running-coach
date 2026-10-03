import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Input } from "./input";

describe("Input", () => {
  it("draws a token-styled field at least 44 px high without a shadow", () => {
    render(<Input aria-label="Target time" />);

    const input = screen.getByRole("textbox", { name: "Target time" });
    expect(input).toHaveClass(
      "min-h-11",
      "rounded-sm",
      "border-line",
      "bg-surface-0",
      "text-body",
      "text-ink",
    );
    expect(input.className).not.toMatch(/shadow/);
  });

  it("gives a placeholder no color of its own, since ink-3 is for non-text", () => {
    render(<Input aria-label="Race date" />);

    expect(screen.getByRole("textbox", { name: "Race date" }).className).not.toMatch(
      /placeholder|ink-3/,
    );
  });

  it("takes typing and passes its type through", async () => {
    render(
      <>
        <Input aria-label="Target time" />
        <Input aria-label="Race date" type="date" />
      </>,
    );

    await userEvent.type(screen.getByRole("textbox", { name: "Target time" }), "49:30");

    expect(screen.getByRole("textbox", { name: "Target time" })).toHaveValue("49:30");
    expect(screen.getByLabelText("Race date")).toHaveAttribute("type", "date");
  });
});
