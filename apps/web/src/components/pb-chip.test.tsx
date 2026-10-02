import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PbChip } from "./pb-chip";

describe("PbChip", () => {
  it("names the distances a run holds as bests beside a dot in the PB gold", () => {
    render(<PbChip distances={["5k", "10k"]} />);

    const chip = screen.getByText("PB 5K, 10K");
    expect(chip).toHaveClass("inline-flex", "items-center", "gap-2");
    // No size or color of its own: a caption line keeps its size and grey around the chip.
    expect(chip).not.toHaveClass("text-body", "text-ink");
    const dot = chip.querySelector("span");
    expect(dot).toHaveClass("size-3", "rounded-sm", "bg-pb");
    expect(dot).toHaveAttribute("aria-hidden", "true");
  });

  it("renders nothing for a run that holds no best", () => {
    const { container } = render(<PbChip distances={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
