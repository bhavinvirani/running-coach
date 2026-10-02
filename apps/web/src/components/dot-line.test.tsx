import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DotLine } from "./dot-line";
import { PbChip } from "./pb-chip";
import { RunTypeChip } from "./run-type-chip";

describe("DotLine", () => {
  it("puts a dot between the items, hidden from screen readers", () => {
    const { container } = render(
      <DotLine className="text-caption text-ink-2">
        <time dateTime="2026-09-27T07:12:00">07:12</time>
        <strong>Race</strong>
        Indoor
      </DotLine>,
    );

    const line = container.querySelector("p");
    // The dots are their own items, spaced by the gap: the text has no spaces around them.
    expect(line).toHaveTextContent(/^07:12·Race·Indoor$/);
    expect(line).toHaveClass("flex", "items-center", "gap-x-1.5", "text-caption", "text-ink-2");
    const dots = container.querySelectorAll("[aria-hidden='true']");
    expect(dots).toHaveLength(2);
    // Each dot travels with the item after it, so a wrap never leaves a dot at a line's end.
    expect(screen.getByText("Indoor").parentElement).toBe(line);
    expect(screen.getByText("Race").parentElement).toHaveTextContent(/^·Race$/);
  });

  it("puts no dot before a chip, whose own colored dot separates it, and keeps one before a word", () => {
    const { container } = render(
      <DotLine>
        <time dateTime="2026-09-27T07:12:00">07:12</time>
        <RunTypeChip eventType="race" />
        <PbChip distances={["5k"]} />
        Indoor
      </DotLine>,
    );

    expect(container.querySelector("p")).toHaveTextContent(/^07:12RacePB 5K·Indoor$/);
    expect(screen.getByText("Indoor").firstElementChild).toHaveTextContent("·");
  });

  it("leaves out null and false items with their dot", () => {
    const { container } = render(
      <DotLine>
        {"07:12"}
        {null}
        {false}
        {"Manual"}
      </DotLine>,
    );

    expect(container.querySelector("p")).toHaveTextContent(/^07:12·Manual$/);
    expect(container.querySelectorAll("[aria-hidden='true']")).toHaveLength(1);
  });

  it("draws no dot for a single item", () => {
    const { container } = render(<DotLine>{"07:12"}</DotLine>);
    expect(container.querySelector("p")).toHaveTextContent(/^07:12$/);
    expect(container.querySelector("[aria-hidden='true']")).toBeNull();
  });
});
