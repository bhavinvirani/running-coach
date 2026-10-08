import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

function LabelledCheckbox({ initial = false }: { initial?: boolean }) {
  const [checked, setChecked] = useState(initial);
  return (
    <label htmlFor="remove" className="flex min-h-11 items-center gap-3">
      <Checkbox
        id="remove"
        checked={checked}
        onCheckedChange={(next) => setChecked(next === true)}
      />
      <span>Also remove workouts</span>
    </label>
  );
}

describe("Checkbox", () => {
  it("draws a token-styled 20 px box with an ink-3 border that turns ink when checked, without accent or a shadow", () => {
    render(<LabelledCheckbox initial />);

    const box = screen.getByRole("checkbox", { name: "Also remove workouts" });
    expect(box).toHaveClass("size-5", "rounded-sm", "border-2", "border-ink-3", "text-ink");
    expect(box).toHaveClass("data-[state=checked]:border-ink");
    expect(box.className).not.toMatch(/shadow|accent|primary/);
  });

  it("is named by its label and toggles from a tap on the label or the box", async () => {
    render(<LabelledCheckbox initial />);

    const box = screen.getByRole("checkbox", { name: "Also remove workouts" });
    expect(box).toBeChecked();
    await userEvent.click(screen.getByText("Also remove workouts"));
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(box).toBeChecked();
  });

  it("toggles from the keyboard with Space", async () => {
    render(<LabelledCheckbox />);

    const box = screen.getByRole("checkbox", { name: "Also remove workouts" });
    box.focus();
    await userEvent.keyboard(" ");

    expect(box).toBeChecked();
  });
});
