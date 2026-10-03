import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ZERO_DURATION, type DurationParts } from "@/lib/duration-parts";
import { DurationField } from "./duration-field";

/** The field as a form holds it: the picked parts in state, the caption read from them. */
function Picked({
  start = ZERO_DURATION,
  onChange = () => {},
}: {
  start?: DurationParts;
  onChange?: (value: DurationParts) => void;
}) {
  const [value, setValue] = useState<DurationParts>(start);
  return (
    <DurationField
      label="Time"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      description={`${value.hours}h ${value.minutes}m ${value.seconds}s`}
    />
  );
}

function picker(name: string) {
  return within(screen.getByRole("group", { name: "Time" })).getByRole("combobox", { name });
}

function optionTexts(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

describe("DurationField", () => {
  it("is a named group of hours, minutes and seconds pickers showing the value", () => {
    render(<Picked start={{ hours: 1, minutes: 43, seconds: 5 }} />);

    expect(picker("Hours")).toHaveValue("1");
    expect(picker("Minutes")).toHaveValue("43");
    expect(picker("Seconds")).toHaveValue("5");
    expect(screen.getByRole("group", { name: "Time" })).toHaveAccessibleDescription("1h 43m 5s");
  });

  it("offers 0 to 9 hours and 00 to 59 minutes and seconds, two digits like a clock", () => {
    render(<Picked />);

    expect(optionTexts(picker("Hours"))).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    for (const name of ["Minutes", "Seconds"]) {
      const options = optionTexts(picker(name));
      expect(options).toHaveLength(60);
      expect(options.slice(0, 3)).toEqual(["00", "01", "02"]);
      expect(options.at(-1)).toBe("59");
    }
  });

  it("offers the hour of a stored time past 9:59:59 so it is not changed on save (stored time above 9 hours)", () => {
    render(<Picked start={{ hours: 11, minutes: 0, seconds: 0 }} />);

    expect(picker("Hours")).toHaveValue("11");
    expect(optionTexts(picker("Hours")).at(-1)).toBe("11");
  });

  it("reports each part picked with the others kept, and the caption follows", async () => {
    const onChange = vi.fn();
    render(<Picked onChange={onChange} />);

    await userEvent.selectOptions(picker("Hours"), "1");
    await userEvent.selectOptions(picker("Minutes"), "43");
    await userEvent.selectOptions(picker("Seconds"), "09");

    expect(onChange).toHaveBeenLastCalledWith({ hours: 1, minutes: 43, seconds: 9 });
    expect(screen.getByRole("group", { name: "Time" })).toHaveAccessibleDescription("1h 43m 9s");
  });

  it("draws token-styled pickers at least 44 px high without a shadow", () => {
    render(<Picked />);

    for (const name of ["Hours", "Minutes", "Seconds"]) {
      const select = picker(name);
      expect(select).toHaveClass(
        "min-h-11",
        "rounded-sm",
        "border-line",
        "bg-surface-0",
        "text-body",
        "text-ink",
      );
      expect(select.className).not.toMatch(/shadow/);
    }
  });

  it("says what is wrong with the time under the pickers, as an alert in ink", () => {
    render(
      <DurationField
        label="Time"
        value={{ hours: 0, minutes: 5, seconds: 0 }}
        onChange={() => {}}
        description="Pace 1:00 /km"
        error="That time is faster or slower than any run; check the hours and minutes"
      />,
    );

    const alert = within(screen.getByRole("group", { name: "Time" })).getByRole("alert");
    expect(alert).toHaveTextContent(
      "That time is faster or slower than any run; check the hours and minutes",
    );
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(screen.getByText("Pace 1:00 /km")).toBeInTheDocument();
  });

  it("hides the pickers and the caption behind a checked No target, and shows them once unchecked (no target)", async () => {
    const onNone = vi.fn();
    const { rerender } = render(
      <DurationField
        label="Target time"
        value={ZERO_DURATION}
        onChange={() => {}}
        none={{ label: "No target", checked: true, onChange: onNone }}
        description="Pace 4:53 /km"
      />,
    );

    const group = screen.getByRole("group", { name: "Target time" });
    const none = within(group).getByRole("checkbox", { name: "No target" });
    expect(none).toBeChecked();
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();
    expect(group).not.toHaveAccessibleDescription();

    await userEvent.click(within(group).getByText("No target"));
    expect(onNone).toHaveBeenCalledWith(false);

    rerender(
      <DurationField
        label="Target time"
        value={ZERO_DURATION}
        onChange={() => {}}
        none={{ label: "No target", checked: false, onChange: onNone }}
        description="Pace 4:53 /km"
      />,
    );
    expect(within(group).getAllByRole("combobox")).toHaveLength(3);
    expect(group).toHaveAccessibleDescription("Pace 4:53 /km");
  });
});
