import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SegmentedField } from "./segmented-field";

const options = [
  { value: "race", label: "Race" },
  { value: "fitness", label: "Fitness" },
] as const;

describe("SegmentedField", () => {
  it("is a named group of radios with the value checked and its description", () => {
    render(
      <SegmentedField
        name="kind"
        legend="Training for"
        options={options}
        value="race"
        onChange={() => {}}
        description="What the plan builds up to."
      />,
    );

    const group = screen.getByRole("group", { name: "Training for" });
    expect(group).toHaveAccessibleDescription("What the plan builds up to.");
    expect(screen.getByRole("radio", { name: "Race" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Fitness" })).not.toBeChecked();
  });

  it("checks nothing while the value is null", () => {
    render(
      <SegmentedField
        name="kind"
        legend="Training for"
        options={options}
        value={null}
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("radio", { name: "Race" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Fitness" })).not.toBeChecked();
  });

  it("reports the option tapped", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedField
        name="kind"
        legend="Training for"
        options={options}
        value="race"
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByText("Fitness"));

    expect(onChange).toHaveBeenCalledWith("fitness");
  });
});
