import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChoiceList, ChoiceListSkeleton, type ChoiceOption } from "./choice-list";

type Size = "s" | "m" | "l";

const options: readonly ChoiceOption<Size>[] = [
  { value: "s", label: "Small", helper: "Fits one." },
  { value: "m", label: "Medium", helper: "Fits two." },
  { value: "l", label: "Large", helper: "Fits three." },
];

function renderList(value: Size = "m", onChange = vi.fn()) {
  render(<ChoiceList label="Size" options={options} value={value} onChange={onChange} />);
  return onChange;
}

describe("ChoiceList", () => {
  it("names the group, lists the options in order and checks the value", () => {
    renderList();

    const group = screen.getByRole("radiogroup", { name: "Size" });
    expect(group).toHaveClass("bg-surface-1", "divide-y", "rounded-md");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(screen.getByRole("radio", { name: "Medium" })).toBeChecked();
  });

  it("describes each option by its helper line, in caption ink-2 under the label", () => {
    renderList();

    expect(screen.getByRole("radio", { name: "Large" })).toHaveAccessibleDescription("Fits three.");
    expect(screen.getByText("Fits three.")).toHaveClass("text-caption", "text-ink-2");
    expect(screen.getByText("Large")).toHaveClass("text-body", "text-ink");
  });

  it("marks the checked radio with ink and the others with ink-3", () => {
    renderList();

    expect(screen.getByRole("radio", { name: "Medium" })).toHaveClass("aria-checked:border-ink");
    expect(screen.getByRole("radio", { name: "Small" })).toHaveClass("border-ink-3");
  });

  it("picks an option from a tap anywhere on its row, the helper line too", async () => {
    const onChange = renderList();

    await userEvent.click(screen.getByText("Fits one."));

    expect(onChange).toHaveBeenCalledWith("s");
  });

  it("describes the group by its caption under the card", () => {
    render(
      <ChoiceList
        label="Size"
        options={options}
        value="s"
        onChange={vi.fn()}
        description="Everywhere in the app."
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Size" })).toHaveAccessibleDescription(
      "Everywhere in the app.",
    );
    expect(screen.getByText("Everywhere in the app.")).toHaveClass("text-caption", "text-ink-2");
  });

  it("picks the next option with the arrow keys", async () => {
    const onChange = renderList();
    screen.getByRole("radio", { name: "Medium" }).focus();

    // Held down: Radix moves focus a tick later, and a radio focused while an arrow is down picks itself.
    await userEvent.keyboard("{ArrowDown>}");

    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("l"));
    expect(screen.getByRole("radio", { name: "Large" })).toHaveFocus();
    await userEvent.keyboard("{/ArrowDown}");
  });
});

describe("ChoiceListSkeleton", () => {
  it("draws one row per option at the loaded height while it loads", () => {
    render(<ChoiceListSkeleton rows={3} label="Loading units" />);

    const status = screen.getByRole("status", { name: "Loading units" });
    const card = status.firstElementChild;
    expect(card?.children).toHaveLength(3);
    for (const row of Array.from(card?.children ?? [])) expect(row).toHaveClass("min-h-12", "py-3");
  });
});
