import { describe, expect, it } from "vitest";
import { toLapPoint } from "./lap-point";
import { MIN_BAR_PERCENT, toSplitRows } from "./split-row";

/** Whole kilometers at these lap times, as a screen builds them from the API's meters and seconds. */
function kmLaps(...seconds: number[]) {
  return seconds.map((durationS, position) =>
    toLapPoint({ index: position + 1, distanceM: 1000, durationS }, "km"),
  );
}

describe("toSplitRows", () => {
  it("draws the fastest lap full width and every other lap in proportion to its speed", () => {
    const rows = toSplitRows(kmLaps(330, 300, 310));
    // 300 / 330 = 90.9 %, 300 / 310 = 96.8 %.
    expect(rows.map((row) => row.barPercent)).toEqual([91, 100, 97]);
  });

  it("keeps a lap three times slower than the fastest at the minimum width, so its pace still fits", () => {
    const rows = toSplitRows(kmLaps(300, 900));
    expect(MIN_BAR_PERCENT).toBe(40);
    expect(rows[1]?.barPercent).toBe(40);
  });

  it("compares each lap with the one before: faster positive, slower negative, the first lap blank", () => {
    const rows = toSplitRows(kmLaps(330, 300, 327, 327));
    expect(rows.map((row) => row.deltaSeconds)).toEqual([null, 30, -27, 0]);
  });

  it("compares the paces as shown, so two laps that both read 5:09 differ by 0:00", () => {
    // 308.6 s and 309.4 s both read 5:09; raw seconds would say -0:01.
    const rows = toSplitRows(kmLaps(308.6, 309.4));
    expect(rows[1]?.deltaSeconds).toBe(0);
  });

  it("gives a GPS glitch no bar and no delta, blanks the next lap's delta and never scales to it (GPS glitches)", () => {
    // 110 s for a km is 1:50/km: the GPS jumped.
    const rows = toSplitRows(kmLaps(300, 110, 310, 320));
    expect(rows[1]).toMatchObject({ gpsGlitch: true, barPercent: null, deltaSeconds: null });
    expect(rows[2]?.deltaSeconds).toBeNull();
    expect(rows[3]?.deltaSeconds).toBe(-10);
    expect(rows[0]?.barPercent).toBe(100);
  });

  it("gives a treadmill lap without distance no bar and no delta, and blanks the next lap's (indoor run)", () => {
    const laps = [
      toLapPoint({ index: 1, distanceM: 1000, durationS: 300 }, "km"),
      toLapPoint({ index: 2, distanceM: 0, durationS: 300 }, "km"),
      toLapPoint({ index: 3, distanceM: 1000, durationS: 310 }, "km"),
    ];
    const rows = toSplitRows(laps);
    expect(rows[1]).toMatchObject({
      label: "2",
      paceSecondsPerUnit: null,
      gpsGlitch: false,
      barPercent: null,
      deltaSeconds: null,
    });
    expect(rows[2]?.deltaSeconds).toBeNull();
  });

  it("labels km auto-laps shown in miles by their numbers, not as 0.62 each (unit conversion)", () => {
    const laps = [1, 2, 3].map((index) =>
      toLapPoint({ index, distanceM: 1000, durationS: 300 }, "mi"),
    );
    expect(toSplitRows(laps).map((row) => row.label)).toEqual(["1", "2", "3"]);
  });

  it("labels a lap by its number, and a lap shorter than the unit by its distance (short last lap)", () => {
    const laps = [
      toLapPoint({ index: 1, distanceM: 1000, durationS: 300 }, "km"),
      toLapPoint({ index: 2, distanceM: 2040, durationS: 620 }, "km"),
      toLapPoint({ index: 3, distanceM: 40, durationS: 19 }, "km"),
    ];
    expect(toSplitRows(laps).map((row) => row.label)).toEqual(["1", "2", "0.04"]);
  });

  it("works in miles: labels, widths and deltas from the paces per mile (unit conversion)", () => {
    const laps = [
      toLapPoint({ index: 1, distanceM: 1609.344, durationS: 480 }, "mi"),
      toLapPoint({ index: 2, distanceM: 1609.344, durationS: 500 }, "mi"),
      // The last 1 km of the run is 0.62 mi.
      toLapPoint({ index: 3, distanceM: 1000, durationS: 300 }, "mi"),
    ];
    const rows = toSplitRows(laps);
    expect(rows.map((row) => row.label)).toEqual(["1", "2", "0.62"]);
    // 300 s for 0.621 mi is 8:03 a mile: 483 s.
    expect(rows.map((row) => row.paceSecondsPerUnit && Math.round(row.paceSecondsPerUnit))).toEqual(
      [480, 500, 483],
    );
    expect(rows.map((row) => row.barPercent)).toEqual([100, 96, 99]);
    expect(rows.map((row) => row.deltaSeconds)).toEqual([null, -20, 17]);
  });

  it("returns no rows for no laps", () => {
    expect(toSplitRows([])).toEqual([]);
  });
});
