import { describe, expect, it } from "vitest";
import { errorMessages } from "@/lib/errors";
import { goalFixture } from "@/test/fixtures";
import { goalForm, goalInput, type GoalForm } from "./goal-form";

const race: GoalForm = {
  kind: "race",
  distanceKey: "half",
  raceDate: "2027-03-14",
  targetTime: "",
  daysPerWeek: 4,
  longRunDay: "sun",
  showRecentTime: false,
  recentDistanceKey: "5k",
  recentTime: "",
};

describe("goalForm", () => {
  it("starts a first goal as a race with nothing picked or typed", () => {
    expect(goalForm(null)).toEqual({ ...race, distanceKey: null, raceDate: "" });
  });

  it("starts from the current goal, its times as the runner would type them", () => {
    expect(goalForm(goalFixture({ recentTime: { distanceKey: "half", timeS: 6972 } }))).toEqual({
      kind: "race",
      distanceKey: "10k",
      raceDate: "2026-10-25",
      targetTime: "49:00",
      daysPerWeek: 4,
      longRunDay: "sun",
      showRecentTime: true,
      recentDistanceKey: "half",
      recentTime: "1:56:12",
    });
  });
});

describe("goalInput", () => {
  it("sends null for an empty target time and an unopened recent time", () => {
    expect(goalInput({ ...race, recentTime: "25:00" })).toEqual({
      ok: true,
      goal: {
        kind: "race",
        distanceKey: "half",
        raceDate: "2027-03-14",
        targetTimeS: null,
        daysPerWeek: 4,
        longRunDay: "sun",
        recentTime: null,
      },
    });
  });

  it("parses the target and recent times into seconds", () => {
    const result = goalInput({
      ...race,
      targetTime: " 1:45:00 ",
      showRecentTime: true,
      recentDistanceKey: "1mi",
      recentTime: "6:40",
    });
    expect(result).toMatchObject({
      ok: true,
      goal: { targetTimeS: 6300, recentTime: { distanceKey: "1mi", timeS: 400 } },
    });
  });

  it("never sends a race date or target time with a fitness goal", () => {
    const result = goalInput({ ...race, kind: "fitness", distanceKey: null, targetTime: "49:00" });
    expect(result).toMatchObject({
      ok: true,
      goal: { kind: "fitness", distanceKey: null, raceDate: null, targetTimeS: null },
    });
  });

  it("ignores an unreadable target time on a fitness goal, which does not send one", () => {
    expect(goalInput({ ...race, kind: "fitness", targetTime: "soon" }).ok).toBe(true);
  });

  it("says which time it cannot read", () => {
    expect(goalInput({ ...race, targetTime: "1h45" })).toEqual({
      ok: false,
      message: "Enter the target time as h:mm:ss or mm:ss, or leave it empty.",
    });
    expect(goalInput({ ...race, showRecentTime: true, recentTime: "25" })).toEqual({
      ok: false,
      message: "Enter the recent race time as h:mm:ss or mm:ss, or leave it empty.",
    });
  });

  it("asks for the race distance first, then the race date", () => {
    expect(goalInput({ ...race, distanceKey: null, raceDate: "" })).toEqual({
      ok: false,
      message: "Pick a race distance.",
    });
    expect(goalInput({ ...race, raceDate: "" })).toEqual({
      ok: false,
      message: "Pick a race date.",
    });
  });

  it("falls back to the validation message for anything else the contract refuses", () => {
    expect(goalInput({ ...race, daysPerWeek: 7 })).toEqual({
      ok: false,
      message: errorMessages.validation,
    });
  });
});
