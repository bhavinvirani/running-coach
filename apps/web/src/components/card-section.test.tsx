import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardSection } from "./card-section";

describe("CardSection", () => {
  it("names the region by its heading and puts the rows on a surface-1 card", () => {
    render(
      <CardSection title="Steps">
        <p>Warm-up</p>
        <p>Cool-down</p>
      </CardSection>,
    );

    const region = screen.getByRole("region", { name: "Steps" });
    expect(screen.getByRole("heading", { name: "Steps" })).toHaveClass(
      "text-body",
      "font-semibold",
    );
    expect(screen.getByText("Warm-up").parentElement).toHaveClass("bg-surface-1", "divide-y");
    expect(region).toContainElement(screen.getByText("Cool-down"));
  });
});
