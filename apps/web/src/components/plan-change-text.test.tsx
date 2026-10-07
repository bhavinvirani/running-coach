import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { planChangeFixture } from "@/test/fixtures-adaptation";
import { PlanChangeText } from "./plan-change-text";

describe("PlanChangeText", () => {
  it("reads the session before and after the change, without the limits caption when applied as proposed", () => {
    render(<PlanChangeText change={planChangeFixture()} units="km" />);
    expect(screen.getByText("Thu 8 Intervals 11.6 km → Easy 10.6 km")).toHaveClass(
      "text-body",
      "text-ink",
    );
    expect(screen.queryByText("Kept inside the plan's limits")).not.toBeInTheDocument();
  });

  it("says the change was kept inside the plan's limits when the engine clamped it (clamped)", () => {
    render(<PlanChangeText change={planChangeFixture({ clamped: true })} units="km" />);
    expect(screen.getByText("Kept inside the plan's limits")).toHaveClass(
      "text-caption",
      "text-ink-2",
    );
  });

  it("gives the distances in mi when the runner uses miles (unit conversion)", () => {
    render(<PlanChangeText change={planChangeFixture()} units="mi" />);
    expect(screen.getByText("Thu 8 Intervals 7.2 mi → Easy 6.6 mi")).toBeInTheDocument();
  });
});
