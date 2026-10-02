import { sessionTypeSchema, type SessionType } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTypeChip } from "./session-type-chip";

const expected: Record<SessionType, { name: string; color: string }> = {
  easy: { name: "Easy", color: "bg-type-easy" },
  intervals: { name: "Intervals", color: "bg-type-intervals" },
  tempo: { name: "Tempo", color: "bg-type-tempo" },
  long: { name: "Long run", color: "bg-type-long" },
  race_practice: { name: "Race practice", color: "bg-type-race" },
  race: { name: "Race", color: "bg-type-race" },
  strength: { name: "Strength", color: "bg-type-strength" },
  rest: { name: "Rest", color: "bg-type-rest" },
};

describe("SessionTypeChip", () => {
  it.each(sessionTypeSchema.options)("names %s beside a dot in its type color", (type) => {
    render(<SessionTypeChip type={type} />);

    const chip = screen.getByText(expected[type].name);
    expect(chip).toHaveClass("inline-flex", "items-center", "gap-2");
    // No size or color of its own: the line around it decides both.
    expect(chip).not.toHaveClass("text-body", "text-caption", "text-ink");
    const dot = chip.querySelector("span");
    expect(dot).toHaveClass("size-3", "rounded-sm", expected[type].color);
    expect(dot).toHaveAttribute("aria-hidden", "true");
  });
});
