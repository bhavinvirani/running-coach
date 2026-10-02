import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Stat } from "./stat";

describe("Stat", () => {
  it("shows the label, the figure and the unit", () => {
    render(<Stat label="Avg pace" value="5:13" unit="/km" />);
    expect(screen.getByText("Avg pace")).toHaveClass("text-caption", "text-ink-2");
    const figure = screen.getByText("5:13");
    expect(figure).toHaveClass("text-figure", "text-ink");
    expect(figure).toHaveTextContent("5:13/km");
    expect(screen.getByText("/km")).toHaveClass("text-caption");
  });

  it("renders without a unit", () => {
    render(<Stat label="Time" value="52:18" />);
    expect(screen.getByText("52:18")).toHaveTextContent(/^52:18$/);
  });

  it("merges a caller class without losing its own", () => {
    const { container } = render(<Stat label="Time" value="52:18" className="col-span-2" />);
    expect(container.firstChild).toHaveClass("col-span-2", "flex");
  });
});
