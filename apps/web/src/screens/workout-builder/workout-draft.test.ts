import {
  GARMIN_WORKOUT_STEPS_MAX,
  REPEAT_STEPS_MAX,
  type CustomSessionType,
} from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { errorMessages } from "@/lib/errors";
import { customSessionFixture } from "@/test/fixtures";
import {
  addRepeat,
  addStep,
  chooseType,
  draftFromSession,
  draftSteps,
  isRepeatDraft,
  newDraft,
  presetDistance,
  presetItems,
  removeItem,
  updateRepeat,
  updateStep,
  workoutInput,
  type ItemDraft,
  type RepeatDraft,
  type StepDraft,
  type WorkoutDraft,
} from "./workout-draft";

const TODAY = "2026-10-08";

/** The items without their React keys, for comparing. */
function shape(items: ItemDraft[]) {
  const step = ({ kind, zone, amount, unit }: StepDraft) => ({ kind, zone, amount, unit });
  return items.map((item) =>
    isRepeatDraft(item) ? { repeat: item.repeat, steps: item.steps.map(step) } : step(item),
  );
}

function firstStep(draft: WorkoutDraft): StepDraft {
  return draft.items[0] as StepDraft;
}

describe("presetItems", () => {
  it.each<[CustomSessionType, ReturnType<typeof shape>]>([
    ["easy", [{ kind: "run", zone: "easy", amount: "5", unit: "km" }]],
    ["long", [{ kind: "run", zone: "easy", amount: "12", unit: "km" }]],
    [
      "tempo",
      [
        { kind: "warmup", zone: "easy", amount: "15", unit: "min" },
        { kind: "work", zone: "threshold", amount: "20", unit: "min" },
        { kind: "cooldown", zone: "easy", amount: "10", unit: "min" },
      ],
    ],
    [
      "intervals",
      [
        { kind: "warmup", zone: "easy", amount: "15", unit: "min" },
        {
          repeat: "5",
          steps: [
            { kind: "work", zone: "interval", amount: "1", unit: "km" },
            { kind: "recovery", zone: "easy", amount: "3", unit: "min" },
          ],
        },
        { kind: "cooldown", zone: "easy", amount: "10", unit: "min" },
      ],
    ],
    [
      "race_practice",
      [
        { kind: "warmup", zone: "easy", amount: "15", unit: "min" },
        { kind: "work", zone: "race", amount: "5", unit: "km" },
        { kind: "cooldown", zone: "easy", amount: "10", unit: "min" },
      ],
    ],
  ])("starts %s from its preset in km", (type, expected) => {
    expect(shape(presetItems(type, "km"))).toEqual(expected);
  });

  it("reads preset distances as round miles and a sub-mile rep in meters (unit conversion)", () => {
    expect(shape(presetItems("easy", "mi"))).toEqual([
      { kind: "run", zone: "easy", amount: "3", unit: "mi" },
    ]);
    expect(shape(presetItems("long", "mi"))).toEqual([
      { kind: "run", zone: "easy", amount: "7.5", unit: "mi" },
    ]);
    const [, repeat] = presetItems("intervals", "mi");
    expect(shape((repeat as RepeatDraft).steps)[0]).toEqual({
      kind: "work",
      zone: "interval",
      amount: "1000",
      unit: "m",
    });
  });
});

describe("presetDistance", () => {
  it("rounds miles to the half mile and keeps under a mile in meters", () => {
    expect(presetDistance(5000, "mi")).toEqual({ amount: "3", unit: "mi" });
    expect(presetDistance(12_000, "mi")).toEqual({ amount: "7.5", unit: "mi" });
    expect(presetDistance(1000, "mi")).toEqual({ amount: "1000", unit: "m" });
    expect(presetDistance(5000, "km")).toEqual({ amount: "5", unit: "km" });
  });
});

describe("chooseType", () => {
  it("loads the type's preset while the steps are untouched", () => {
    const draft = chooseType(newDraft(TODAY, "km"), "tempo", "km");

    expect(draft.type).toBe("tempo");
    expect(shape(draft.items)).toEqual(shape(presetItems("tempo", "km")));
    expect(draft.edited).toBe(false);
  });

  it("keeps the runner's steps once one was changed", () => {
    const start = newDraft(TODAY, "km");
    const edited = updateStep(start, firstStep(start).id, { amount: "8" });
    const draft = chooseType(edited, "long", "km");

    expect(draft.type).toBe("long");
    expect(shape(draft.items)).toEqual([{ kind: "run", zone: "easy", amount: "8", unit: "km" }]);
  });
});

describe("updateStep", () => {
  it("puts a step that turns into a warm-up, recovery or cool-down back on easy", () => {
    const tempo = chooseType(newDraft(TODAY, "km"), "tempo", "km");
    const work = tempo.items[1] as StepDraft;
    const draft = updateStep(tempo, work.id, { kind: "recovery" });

    expect(draft.items[1]).toMatchObject({ kind: "recovery", zone: "easy" });
  });

  it("changes a step inside a repeat", () => {
    const intervals = chooseType(newDraft(TODAY, "km"), "intervals", "km");
    const repeat = intervals.items[1] as RepeatDraft;
    const draft = updateStep(intervals, repeat.steps[0]!.id, { amount: "800", unit: "m" });

    expect((draft.items[1] as RepeatDraft).steps[0]).toMatchObject({ amount: "800", unit: "m" });
  });
});

describe("adding and removing", () => {
  it("adds a step and a repeat at the end and a rep inside a repeat, up to its cap", () => {
    let draft = addRepeat(addStep(newDraft(TODAY, "km")));
    expect(shape(draft.items).slice(1)).toEqual([
      { kind: "run", zone: "easy", amount: "10", unit: "min" },
      {
        repeat: "4",
        steps: [
          { kind: "work", zone: "interval", amount: "400", unit: "m" },
          { kind: "recovery", zone: "easy", amount: "2", unit: "min" },
        ],
      },
    ]);
    const repeatId = draft.items[2]!.id;
    for (let step = 0; step < REPEAT_STEPS_MAX + 2; step += 1) draft = addStep(draft, repeatId);
    expect((draft.items[2] as RepeatDraft).steps).toHaveLength(REPEAT_STEPS_MAX);
  });

  it("removes a step, a repeat, or a rep, but never a repeat's last rep", () => {
    const intervals = chooseType(newDraft(TODAY, "km"), "intervals", "km");
    const repeat = intervals.items[1] as RepeatDraft;

    expect(removeItem(intervals, intervals.items[0]!.id).items).toHaveLength(2);
    expect(removeItem(intervals, repeat.id).items).toHaveLength(2);
    const oneRep = removeItem(intervals, repeat.steps[1]!.id);
    expect((oneRep.items[1] as RepeatDraft).steps).toHaveLength(1);
    const kept = removeItem(oneRep, (oneRep.items[1] as RepeatDraft).steps[0]!.id);
    expect((kept.items[1] as RepeatDraft).steps).toHaveLength(1);
  });
});

describe("workoutInput", () => {
  it("turns minutes into seconds and km into meters, with an empty title as null", () => {
    const draft = chooseType(newDraft(TODAY, "km"), "intervals", "km");

    expect(workoutInput(draft, "km", TODAY)).toEqual({
      ok: true,
      input: {
        date: TODAY,
        type: "intervals",
        title: null,
        steps: [
          { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
          {
            repeat: 5,
            steps: [
              { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
              { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
            ],
          },
          { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
        ],
      },
    });
  });

  it("turns miles and meters into meters and a decimal comma into a point (unit conversion)", () => {
    const start = { ...newDraft(TODAY, "mi"), title: "  Hill reps  " };
    const step = firstStep(start);
    const miles = workoutInput(updateStep(start, step.id, { amount: "3,5" }), "mi", TODAY);
    const meters = workoutInput(
      updateStep(start, step.id, { amount: "400", unit: "m" }),
      "mi",
      TODAY,
    );

    expect(miles).toMatchObject({
      ok: true,
      input: { title: "Hill reps", steps: [{ distanceM: 5633, durationS: null }] },
    });
    expect(meters).toMatchObject({ ok: true, input: { steps: [{ distanceM: 400 }] } });
  });

  it("asks for a date from today on", () => {
    const draft = { ...newDraft("2026-10-07", "km") };
    expect(workoutInput(draft, "km", TODAY)).toEqual({
      ok: false,
      message: "Pick a date from today on.",
    });
    expect(workoutInput({ ...draft, date: "" }, "km", TODAY)).toMatchObject({ ok: false });
  });

  it("asks for at least one step", () => {
    const start = newDraft(TODAY, "km");
    expect(workoutInput(removeItem(start, firstStep(start).id), "km", TODAY)).toEqual({
      ok: false,
      message: "Add at least one step.",
    });
  });

  it("names the step whose amount is missing or not a number above zero, inside a repeat too", () => {
    const intervals = chooseType(newDraft(TODAY, "km"), "intervals", "km");
    const rep = (intervals.items[1] as RepeatDraft).steps[1]!;

    for (const amount of ["", "abc", "0", "-2"]) {
      expect(workoutInput(updateStep(intervals, rep.id, { amount }), "km", TODAY)).toEqual({
        ok: false,
        message: "Enter how long step 2.2 lasts, a number above zero.",
      });
    }
  });

  it("caps a step at 6 h or 100 km, said in the runner's unit", () => {
    const start = newDraft(TODAY, "mi");
    const id = firstStep(start).id;

    expect(workoutInput(updateStep(start, id, { amount: "63" }), "mi", TODAY)).toEqual({
      ok: false,
      message: "Step 1 is too long: a step lasts at most 6 h or 62.1 mi.",
    });
    expect(
      workoutInput(updateStep(start, id, { amount: "361", unit: "min" }), "mi", TODAY),
    ).toMatchObject({ ok: false, message: /^Step 1 is too long/ });
  });

  it("keeps a repeat between 2 and 50 times", () => {
    const intervals = chooseType(newDraft(TODAY, "km"), "intervals", "km");
    const id = intervals.items[1]!.id;

    for (const count of ["1", "51", "2.5", ""]) {
      expect(workoutInput(updateRepeat(intervals, id, count), "km", TODAY)).toEqual({
        ok: false,
        message: "Repeat 2 runs 2 to 50 times. Change its count.",
      });
    }
    expect(workoutInput(updateRepeat(intervals, id, "50"), "km", TODAY)).toMatchObject({
      ok: true,
    });
  });

  it("refuses more steps than a watch workout holds, counting a repeat as one plus its steps (step cap)", () => {
    let draft = newDraft(TODAY, "km");
    for (let step = 1; step < GARMIN_WORKOUT_STEPS_MAX; step += 1) draft = addStep(draft);
    expect(workoutInput(draft, "km", TODAY)).toMatchObject({ ok: true });

    draft = addRepeat(draft);
    expect(workoutInput(draft, "km", TODAY)).toEqual({
      ok: false,
      message:
        "This workout has 53 steps and a watch workout holds 50, a repeat counting one plus its steps. Remove 3.",
    });
  });

  it("falls back to the validation message for what only the contract catches", () => {
    const draft = { ...newDraft(TODAY, "km"), title: "x".repeat(61) };
    expect(workoutInput(draft, "km", TODAY)).toEqual({
      ok: false,
      message: errorMessages.validation,
    });
  });
});

describe("draftSteps", () => {
  it("reads the steps for the summary, and nothing while an amount is unfinished", () => {
    const start = newDraft(TODAY, "km");
    expect(draftSteps(start.items, "km")).toEqual([
      { kind: "run", zone: "easy", distanceM: 5000, durationS: null },
    ]);
    expect(
      draftSteps(updateStep(start, firstStep(start).id, { amount: "" }).items, "km"),
    ).toBeNull();
    expect(draftSteps([], "km")).toBeNull();
  });
});

describe("draftFromSession", () => {
  it("opens a custom workout with its title and steps, minutes and meters as the form shows them", () => {
    const draft = draftFromSession(customSessionFixture(), "km");

    expect(draft).toMatchObject({
      date: "2026-10-09",
      type: "tempo",
      title: "Hill reps",
      edited: true,
    });
    expect(shape(draft.items)).toEqual([
      { kind: "warmup", zone: "easy", amount: "15", unit: "min" },
      {
        repeat: "4",
        steps: [
          { kind: "work", zone: "threshold", amount: "400", unit: "m" },
          { kind: "recovery", zone: "easy", amount: "2", unit: "min" },
        ],
      },
      { kind: "cooldown", zone: "easy", amount: "10", unit: "min" },
    ]);
  });

  it("shows a long step in the runner's unit and sends the same meters back (unit conversion)", () => {
    const session = customSessionFixture({
      steps: [{ kind: "run", zone: "easy", distanceM: 4828, durationS: null }],
    });
    const draft = draftFromSession(session, "mi");

    expect(shape(draft.items)).toEqual([{ kind: "run", zone: "easy", amount: "3", unit: "mi" }]);
    expect(workoutInput(draft, "mi", TODAY)).toMatchObject({
      ok: true,
      input: { steps: [{ distanceM: 4828 }] },
    });
  });
});
