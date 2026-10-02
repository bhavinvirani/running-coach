import { RACE_EVENT_TYPE } from "@running-coach/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { runTypeName } from "@/lib/run-type";
import { RunTypeChip } from "./run-type-chip";

describe("RunTypeChip", () => {
  it("names a race in words beside a dot in the race color", () => {
    render(<RunTypeChip eventType={RACE_EVENT_TYPE} />);

    const chip = screen.getByText("Race");
    expect(chip).toHaveClass("inline-flex", "items-center", "gap-2");
    // No size or color of its own: a caption line keeps its size and grey around the chip.
    expect(chip).not.toHaveClass("text-body", "text-ink");
    const dot = chip.querySelector("span");
    expect(dot).toHaveClass("size-3", "rounded-sm", "bg-type-race");
    expect(dot).toHaveAttribute("aria-hidden", "true");
  });

  it.each([null, "training", "recreation", "uncategorized"])(
    "renders nothing for a run that is no race (%s)",
    (eventType) => {
      const { container } = render(<RunTypeChip eventType={eventType} />);
      expect(container).toBeEmptyDOMElement();
      expect(runTypeName(eventType)).toBeNull();
    },
  );

  it("gives the screen-reader names the same word", () => {
    expect(runTypeName(RACE_EVENT_TYPE)).toBe("Race");
  });
});
