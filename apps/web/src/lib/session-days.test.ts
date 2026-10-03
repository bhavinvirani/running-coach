import { describe, expect, it } from "vitest";
import { canChange, moveDays } from "./session-days";

describe("moveDays", () => {
  it("offers the other days of the session's Monday-to-Sunday week", () => {
    expect(moveDays({ date: "2026-10-08" }, "2026-10-05")).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
  });

  it("offers no day before today, so a missed day is never caught up (missed or moved session)", () => {
    expect(moveDays({ date: "2026-10-09" }, "2026-10-08")).toEqual([
      "2026-10-08",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(moveDays({ date: "2026-10-11" }, "2026-10-11")).toEqual([]);
  });

  it("keeps a Sunday session in its own week, across a month end", () => {
    expect(moveDays({ date: "2026-11-01" }, "2026-10-30")).toEqual(["2026-10-30", "2026-10-31"]);
  });
});

describe("canChange", () => {
  it("lets a planned or moved session from today on change", () => {
    expect(canChange({ date: "2026-10-08", status: "planned" }, "2026-10-08")).toBe(true);
    expect(canChange({ date: "2026-10-09", status: "moved" }, "2026-10-08")).toBe(true);
  });

  it("locks a past, done, missed or skipped session", () => {
    expect(canChange({ date: "2026-10-07", status: "planned" }, "2026-10-08")).toBe(false);
    expect(canChange({ date: "2026-10-08", status: "done" }, "2026-10-08")).toBe(false);
    expect(canChange({ date: "2026-10-08", status: "missed" }, "2026-10-08")).toBe(false);
    expect(canChange({ date: "2026-10-09", status: "skipped" }, "2026-10-08")).toBe(false);
  });
});
