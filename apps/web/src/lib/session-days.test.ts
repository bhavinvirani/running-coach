import { describe, expect, it } from "vitest";
import { canAdd, canChange, moveDays } from "./session-days";

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
  const open = { paused: false } as const;

  it("lets a planned or moved session from today on change", () => {
    expect(canChange({ ...open, date: "2026-10-08", status: "planned" }, "2026-10-08")).toBe(true);
    expect(canChange({ ...open, date: "2026-10-09", status: "moved" }, "2026-10-08")).toBe(true);
  });

  it("locks a past, done, missed or skipped session", () => {
    expect(canChange({ ...open, date: "2026-10-07", status: "planned" }, "2026-10-08")).toBe(false);
    expect(canChange({ ...open, date: "2026-10-08", status: "done" }, "2026-10-08")).toBe(false);
    expect(canChange({ ...open, date: "2026-10-08", status: "missed" }, "2026-10-08")).toBe(false);
    expect(canChange({ ...open, date: "2026-10-09", status: "skipped" }, "2026-10-08")).toBe(false);
  });

  it("locks a session in an open pause, which the end of the pause skips (paused session)", () => {
    expect(canChange({ paused: true, date: "2026-10-09", status: "planned" }, "2026-10-08")).toBe(
      false,
    );
  });
});

describe("canAdd", () => {
  it("takes a workout of the runner's own from today on, never on a past day", () => {
    expect(canAdd("2026-10-08", "2026-10-08", null)).toBe(true);
    expect(canAdd("2026-10-11", "2026-10-08", null)).toBe(true);
    expect(canAdd("2026-10-07", "2026-10-08", null)).toBe(false);
  });

  it("takes none on or after an open pause's start, which the API refuses (no add in pause)", () => {
    expect(canAdd("2026-10-08", "2026-10-08", "2026-10-08")).toBe(false);
    expect(canAdd("2026-10-12", "2026-10-10", "2026-10-08")).toBe(false);
    // A pause dated after today, as a runner who flew west sees it: the days before it still take Add.
    expect(canAdd("2026-10-08", "2026-10-08", "2026-10-09")).toBe(true);
    expect(canAdd("2026-10-09", "2026-10-08", "2026-10-09")).toBe(false);
  });
});
