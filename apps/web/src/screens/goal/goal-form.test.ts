import { describe, expect, it } from "vitest";
import { ZERO_DURATION } from "@/lib/duration-parts";
import { errorMessages } from "@/lib/errors";
import { goalFixture } from "@/test/fixtures";
import { goalForm, goalInput, type GoalForm } from "./goal-form";

const race: GoalForm = {
  kind: "race",
  distanceKey: "half",
  raceDate: "2027-03-14",
  noTargetTime: true,
  targetTime: ZERO_DURATION,
  daysPerWeek: 4,
  longRunDay: "sun",
  showRecentTime: false,
  recentDistanceKey: "5k",
  recentTime: ZERO_DURATION,
};

describe("goalForm", () => {
  it("starts a first goal as a race with No target and nothing picked", () => {
    expect(goalForm(null)).toEqual({ ...race, distanceKey: null, raceDate: "" });
  });

  it("starts from the current goal, its times split for the pickers", () => {
    expect(goalForm(goalFixture({ recentTime: { distanceKey: "half", timeS: 6972 } }))).toEqual({
      kind: "race",
      distanceKey: "10k",
      raceDate: "2026-10-25",
      noTargetTime: false,
      targetTime: { hours: 0, minutes: 49, seconds: 0 },
      daysPerWeek: 4,
      longRunDay: "sun",
      showRecentTime: true,
      recentDistanceKey: "half",
      recentTime: { hours: 1, minutes: 56, seconds: 12 },
    });
  });

  it("ticks No target for a goal saved without one (no target)", () => {
    expect(goalForm(goalFixture({ targetTimeS: null }))).toMatchObject({
      noTargetTime: true,
      targetTime: ZERO_DURATION,
    });
  });
});

describe("goalInput", () => {
  it("sends null for No target and an unopened recent time (no target)", () => {
    const picked = { hours: 0, minutes: 25, seconds: 0 };
    expect(goalInput({ ...race, targetTime: picked, recentTime: picked })).toEqual({
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

  it("adds the picked target and recent times up to seconds", () => {
    const result = goalInput({
      ...race,
      noTargetTime: false,
      targetTime: { hours: 1, minutes: 45, seconds: 0 },
      showRecentTime: true,
      recentDistanceKey: "1mi",
      recentTime: { hours: 0, minutes: 6, seconds: 40 },
    });
    expect(result).toMatchObject({
      ok: true,
      goal: { targetTimeS: 6300, recentTime: { distanceKey: "1mi", timeS: 400 } },
    });
  });

  it("never sends a race date or target time with a fitness goal", () => {
    const result = goalInput({
      ...race,
      kind: "fitness",
      distanceKey: null,
      noTargetTime: false,
      targetTime: { hours: 0, minutes: 49, seconds: 0 },
    });
    expect(result).toMatchObject({
      ok: true,
      goal: { kind: "fitness", distanceKey: null, raceDate: null, targetTimeS: null },
    });
  });

  it("ignores a target of 0:00:00 on a fitness goal, which does not send one", () => {
    expect(goalInput({ ...race, kind: "fitness", noTargetTime: false }).ok).toBe(true);
  });

  it("asks for a target time when No target is unticked and the pickers read 0:00:00", () => {
    expect(goalInput({ ...race, noTargetTime: false })).toEqual({
      ok: false,
      message: "Pick a target time, or tick No target.",
    });
  });

  it("sends no recent time for 0:00:00, which keeps it optional", () => {
    expect(goalInput({ ...race, showRecentTime: true })).toMatchObject({
      ok: true,
      goal: { recentTime: null },
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
