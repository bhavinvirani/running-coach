import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderScreen } from "@/test/render";
import { BestEffortRow, BestEffortRowSkeleton, BestEffortTile } from "./best-effort-row";

/** The tiles a screen would build: a linked best with a chip and two captions, a plain effort, a gap. */
function Row() {
  return (
    <BestEffortRow label="Best efforts">
      <BestEffortTile
        label="Half"
        name="Half, 1:56:12, 6 Apr 2025, Garmin 1:56:12, New"
        personalBest
        chip="New"
        time="1:56:12"
        captions={[
          { text: "6 Apr 2025", dateTime: "2025-04-06T09:00:00" },
          { text: "Garmin 1:56:12" },
        ]}
        href="/runs/race"
      />
      <BestEffortTile
        label="10K"
        name="10K, 51:59, 5:12 /km"
        time="51:59"
        captions={[{ text: "5:12 /km" }]}
      />
      <BestEffortTile label="Marathon" name="Marathon, No run yet" noTime="No run yet" />
    </BestEffortRow>
  );
}

function renderRow() {
  return renderScreen(<Row />);
}

function tile(label: string) {
  const item = screen
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText(label, { exact: true }));
  if (item === undefined) throw new Error(`No tile for ${label}`);
  return item;
}

describe("BestEffortRow", () => {
  it("is one list named for screen readers, a tile per item in the order given", () => {
    renderRow();

    const list = screen.getByRole("list", { name: "Best efforts" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Half"),
      expect.stringContaining("10K"),
      expect.stringContaining("Marathon"),
    ]);
  });

  it("bleeds to the screen's edges, pads back in line with the heading and snaps a tile to that edge", () => {
    renderRow();

    const list = screen.getByRole("list", { name: "Best efforts" });
    expect(list).toHaveClass("-mx-4", "px-4", "scroll-px-4", "flex", "gap-2", "py-1");
    expect(list).toHaveClass("overflow-x-auto", "snap-x", "snap-mandatory");
    for (const item of within(list).getAllByRole("listitem")) {
      expect(item).toHaveClass("w-34", "shrink-0", "snap-start");
      expect(item.firstElementChild).toHaveClass(
        "h-full",
        "rounded-md",
        "bg-surface-1",
        "px-2.5",
        "py-2",
        "whitespace-nowrap",
      );
    }
  });

  it("scrolls without a scrollbar (no scrollbar)", () => {
    renderRow();

    expect(screen.getByRole("list", { name: "Best efforts" })).toHaveClass("scrollbar-none");
  });

  it("keeps each tile's screen-reader name inside the row, so tiles past the edge never widen the page", () => {
    renderRow();

    for (const item of screen.getAllByRole("listitem")) {
      const card = item.firstElementChild;
      expect(card).toHaveClass("relative");
      expect(card?.firstElementChild).toHaveClass("sr-only");
    }
  });

  it("takes keyboard focus itself, so arrow keys scroll tiles that are not links into view (keyboard scrolling)", async () => {
    renderRow();

    const list = screen.getByRole("list", { name: "Best efforts" });
    expect(list).toHaveAttribute("tabindex", "0");
    // Inset, so the ring shows at the screen's edges the row bleeds to.
    expect(list).toHaveClass("focus-visible:-outline-offset-2");

    await userEvent.tab();
    expect(list).toHaveFocus();
    await userEvent.tab();
    expect(within(tile("Half")).getByRole("link")).toHaveFocus();
  });
});

describe("BestEffortTile", () => {
  it("shows the label, the chip on the right, the time as a figure and the captions below", () => {
    renderRow();

    const half = tile("Half");
    const label = within(half).getByText("Half");
    expect(label).toHaveClass("text-caption", "text-ink-2");
    const chip = within(half).getByText("New");
    expect(chip).toHaveClass(
      "rounded-full",
      "bg-surface-2",
      "text-caption",
      "font-semibold",
      "text-ink",
    );
    expect(label.parentElement).toBe(chip.parentElement);
    expect(label.parentElement).toHaveClass("justify-between");
    expect(within(half).getByText("1:56:12")).toHaveClass("text-figure", "text-ink");
    const date = within(half).getByText("6 Apr 2025");
    expect(date.tagName).toBe("TIME");
    expect(date).toHaveAttribute("dateTime", "2025-04-06T09:00:00");
    expect(date).toHaveClass("text-caption", "text-ink-2");
    expect(within(half).getByText("Garmin 1:56:12")).toHaveClass("text-caption", "text-ink-2");
  });

  it("marks a personal best with the PB gold beside its label, and nothing else with it", () => {
    renderRow();

    const dot = within(tile("Half")).getByText("Half").querySelector(".bg-pb");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(tile("10K").querySelector(".bg-pb")).toBeNull();
    expect(tile("Marathon").querySelector(".bg-pb")).toBeNull();
  });

  it("opens its href from the whole tile, named in words", () => {
    renderRow();

    const link = within(tile("Half")).getByRole("link");
    expect(link).toBe(tile("Half").firstElementChild);
    expect(link).toHaveAttribute("href", "/runs/race");
    expect(link).toHaveAccessibleName("Half, 1:56:12, 6 Apr 2025, Garmin 1:56:12, New");
  });

  it("reads a tile without a link as one sentence in words, its lines hidden from screen readers", () => {
    renderRow();

    const tenK = tile("10K");
    expect(within(tenK).queryByRole("link")).not.toBeInTheDocument();
    expect(within(tenK).getByText("10K, 51:59, 5:12 /km")).toHaveClass("sr-only");
    const [heard, ...lines] = Array.from(tenK.firstElementChild?.children ?? []);
    expect(heard).toHaveClass("sr-only");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toHaveAttribute("aria-hidden", "true");
  });

  it("says why a distance has no time in its place, in grey body text, and opens nothing (no run yet)", () => {
    renderRow();

    const marathon = tile("Marathon");
    const words = within(marathon).getByText("No run yet");
    expect(words).toHaveClass("text-body", "text-ink-2");
    // In the time's slot, so the tile keeps the height of the others.
    expect(words.parentElement).toHaveClass("h-7.5");
    expect(within(marathon).queryByRole("link")).not.toBeInTheDocument();
    expect(within(marathon).getByText("Marathon, No run yet")).toHaveClass("sr-only");
  });

  it("keeps the time on one line in a slot shorter than the figure's line, so the tile stays low", () => {
    renderRow();

    const time = within(tile("10K")).getByText("51:59");
    expect(time.parentElement).toHaveClass("flex", "h-7.5", "items-center");
  });
});

describe("BestEffortRowSkeleton", () => {
  it("shows the tiles at their loaded size as blocks, not as list items", () => {
    const { container } = render(<BestEffortRowSkeleton count={4} />);

    const row = container.firstElementChild;
    expect(row).toHaveClass("-mx-4", "flex", "gap-2", "px-4", "py-1", "overflow-hidden");
    expect(row?.children).toHaveLength(4);
    for (const slot of Array.from(row?.children ?? [])) {
      expect(slot).toHaveClass("w-34", "shrink-0");
      expect(slot.firstElementChild).toHaveClass("rounded-md", "bg-surface-1", "px-2.5", "py-2");
    }
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
