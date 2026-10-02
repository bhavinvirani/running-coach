import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { toLapPoint, type LapPoint } from "./lap-point";
import { SplitBars } from "./split-bars";

/** Whole kilometers at these lap times, built from meters and seconds the way the run screen builds them. */
function kmLaps(...seconds: number[]): LapPoint[] {
  return seconds.map((durationS, position) =>
    toLapPoint({ index: position + 1, distanceM: 1000, durationS }, "km"),
  );
}

/** Stands in for the run screen's SplitsTable: says how many laps it was asked to list. */
function fakeTable(count: number) {
  return <p>Table of the first {count} laps</p>;
}

function renderBars(laps: LapPoint[], unit: "km" | "mi" = "km") {
  return render(<SplitBars laps={laps} unit={unit} table={fakeTable} />);
}

function rows() {
  return within(screen.getByRole("list", { name: "Splits" })).getAllByRole("listitem");
}

/** The lap's bar, the delta and the label of one row. */
function row(position: number) {
  const item = rows()[position] as HTMLElement;
  const [label, , delta] = [...item.children] as HTMLElement[];
  return { item, label, delta, bar: within(item).queryByRole("img") };
}

// Eighteen laps: a 5:18 start, then 5:00 to 5:17 in a slowing pattern.
const longRun = kmLaps(318, ...Array.from({ length: 17 }, (_, lap) => 300 + lap));

describe("SplitBars", () => {
  it("draws a bar per lap named by its pace, the fastest full width and the rest by their speed", () => {
    renderBars(kmLaps(318, 300, 310));

    expect(rows()).toHaveLength(3);
    const first = row(0);
    expect(first.label).toHaveTextContent(/^1$/);
    expect(first.label).toHaveClass("w-10", "text-body", "text-ink-2");
    expect(first.bar).toHaveAccessibleName("5:18 /km");
    expect(first.bar).toHaveTextContent("5:18 /km");
    // 300 / 318 is 94 %.
    expect(first.bar?.querySelector("rect")).toHaveAttribute("width", "94%");
    expect(first.bar?.querySelector("rect")).toHaveClass("fill-accent");
    expect(row(1).bar?.querySelector("rect")).toHaveAttribute("width", "100%");
    expect(row(2).bar?.querySelector("rect")).toHaveAttribute("width", "97%");
    // 44 px rows.
    expect(first.item).toHaveClass("min-h-11");
  });

  it("signs the change from the lap before: blank first, faster in good, slower in bad, equal in ink-2", () => {
    renderBars(kmLaps(318, 313, 340, 340));

    expect(row(0).delta).toBeEmptyDOMElement();
    expect(row(1).delta).toHaveTextContent(/^\+0:05$/);
    expect(row(1).delta).toHaveClass("text-good");
    expect(row(2).delta).toHaveTextContent(/^-0:27$/);
    expect(row(2).delta).toHaveClass("text-bad");
    expect(row(3).delta).toHaveTextContent(/^0:00$/);
    expect(row(3).delta).toHaveClass("text-ink-2");
  });

  it("shows GPS glitch instead of a bar, no delta there or on the next lap, and says so below (GPS glitches)", () => {
    renderBars(kmLaps(318, 110, 313, 320));

    const glitch = row(1);
    expect(glitch.bar).toBeNull();
    expect(within(glitch.item).getByText("GPS glitch")).toHaveClass("text-body", "text-ink-2");
    expect(glitch.delta).toBeEmptyDOMElement();
    expect(row(2).delta).toBeEmptyDOMElement();
    expect(row(3).delta).toHaveTextContent(/^-0:07$/);
    expect(screen.getByText("1 lap left out as a GPS glitch.")).toHaveClass("text-caption");
  });

  it("labels a lap shorter than the unit with its distance (short last lap)", () => {
    renderBars([...kmLaps(318, 315), toLapPoint({ index: 3, distanceM: 40, durationS: 19 }, "km")]);

    expect(row(2).label).toHaveTextContent(/^0\.04$/);
    expect(row(2).bar).toHaveAccessibleName("7:55 /km");
  });

  it("shows a dash for a treadmill lap without distance, and a sentence when no lap has a pace (indoor run)", async () => {
    const treadmill = [1, 2].map((index) =>
      toLapPoint({ index, distanceM: 0, durationS: 300 }, "km"),
    );
    const { unmount } = renderBars([
      ...kmLaps(318),
      toLapPoint({ index: 2, distanceM: 0, durationS: 300 }, "km"),
    ]);
    expect(within(row(1).item).getByText("–")).toHaveClass("text-ink-2");
    expect(row(1).bar).toBeNull();
    unmount();

    renderBars(treadmill);
    expect(screen.getByText("No lap has a pace to chart.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show table" }));
    expect(screen.getByText("Table of the first 2 laps")).toBeInTheDocument();
  });

  it("names the bars per mile when the runner uses miles (unit conversion)", () => {
    const laps = [
      toLapPoint({ index: 1, distanceM: 1609.344, durationS: 480 }, "mi"),
      toLapPoint({ index: 2, distanceM: 1000, durationS: 300 }, "mi"),
    ];
    renderBars(laps, "mi");

    expect(row(0).bar).toHaveAccessibleName("8:00 /mi");
    expect(row(1).label).toHaveTextContent(/^0\.62$/);
    expect(row(1).bar).toHaveAccessibleName("8:03 /mi");
    expect(row(1).delta).toHaveTextContent(/^-0:03$/);
  });

  it("shows the first 12 laps, all of them on Show all, and 12 again on Show fewer", async () => {
    renderBars(longRun);

    expect(rows()).toHaveLength(12);
    await userEvent.click(screen.getByRole("button", { name: "Show all 18 laps" }));
    expect(rows()).toHaveLength(18);
    await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(rows()).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Show all 18 laps" })).toBeInTheDocument();
  });

  it("offers no Show all for 12 laps or fewer", () => {
    renderBars(longRun.slice(0, 12));
    expect(rows()).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show table" })).toBeInTheDocument();
  });

  it("switches to the table with the same 12-lap cap and Show all, and back to the bars", async () => {
    renderBars(longRun);

    await userEvent.click(screen.getByRole("button", { name: "Show table" }));
    expect(screen.getByText("Table of the first 12 laps")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Splits" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show all 18 laps" }));
    expect(screen.getByText("Table of the first 18 laps")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(rows()).toHaveLength(18);
  });

  it("says there are no laps and offers no buttons for an empty list", () => {
    renderBars([]);
    expect(screen.getByText("No laps recorded for this run.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
