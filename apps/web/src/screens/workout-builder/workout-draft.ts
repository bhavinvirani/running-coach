import {
  GARMIN_WORKOUT_STEPS_MAX,
  METERS_PER_KM,
  REPEAT_MAX,
  REPEAT_STEPS_MAX,
  STEP_MAX_DISTANCE_M,
  STEP_MAX_DURATION_S,
  customSessionInputSchema,
  distanceInUnits,
  garminStepCount,
  metersPerUnit,
  type CustomSessionInput,
  type CustomSessionType,
  type PaceZone,
  type PlanSession,
  type Repeat,
  type SessionSteps,
  type Step,
  type StepKind,
  type Units,
} from "@running-coach/shared";
import { errorMessages } from "@/lib/errors";
import { formatStepDistance, formatStepDuration } from "@/lib/format";
import { isPacedStep } from "@/lib/workout-steps";

/**
 * The workout builder's form as the runner types it, and the pure steps from it to the API's
 * customSessionInputSchema. Amounts stay text until saved, so a half-typed "2." is never rewritten.
 */

/** What an amount counts: minutes, the runner's distance unit, or meters for track reps. */
export type AmountUnit = "min" | Units | "m";

export type StepDraft = {
  /** A React key, never sent. */
  id: string;
  kind: StepKind;
  zone: PaceZone;
  amount: string;
  unit: AmountUnit;
};

export type RepeatDraft = { id: string; repeat: string; steps: StepDraft[] };

export type ItemDraft = StepDraft | RepeatDraft;

export type WorkoutDraft = {
  date: string;
  type: CustomSessionType;
  title: string;
  items: ItemDraft[];
  /**
   * True once the runner changed a step: choosing another type then keeps the steps instead of loading
   * that type's preset over them.
   */
  edited: boolean;
};

export function isRepeatDraft(item: ItemDraft): item is RepeatDraft {
  return "repeat" in item;
}

let lastId = 0;

function draftId(): string {
  lastId += 1;
  return `draft-${lastId}`;
}

/** The amount units a step offers, for the runner's distance unit. */
export function amountUnits(units: Units): readonly AmountUnit[] {
  return ["min", units, "m"];
}

/** Up to two decimals without trailing zeros: 7.45 → "7.45", 3.0 → "3", 2.5 → "2.5". */
function amountText(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * A preset's distance as the runner reads it: whole kilometers, or in miles the nearest half mile (5 km is
 * "3 mi", 12 km "7.5 mi"), so no preset reads 3.11. Under a mile in mile units, a rep stays in meters, as
 * on a track ("1000 m").
 */
export function presetDistance(
  distanceM: number,
  units: Units,
): Pick<StepDraft, "amount" | "unit"> {
  if (units === "km") return { amount: amountText(distanceM / METERS_PER_KM), unit: "km" };
  const miles = distanceInUnits(distanceM, "mi");
  if (miles < 1) return { amount: amountText(distanceM), unit: "m" };
  return { amount: amountText(Math.round(miles * 2) / 2), unit: "mi" };
}

type PresetStep = { kind: StepKind; zone: PaceZone } & (
  { distanceM: number; minutes?: never } | { minutes: number; distanceM?: never }
);
type PresetItem = PresetStep | { repeat: number; steps: PresetStep[] };

const WARM_UP: PresetStep = { kind: "warmup", zone: "easy", minutes: 15 };
const COOL_DOWN: PresetStep = { kind: "cooldown", zone: "easy", minutes: 10 };

/** Where each type starts: one sensible session the runner then adjusts. */
const PRESETS: Readonly<Record<CustomSessionType, readonly PresetItem[]>> = {
  easy: [{ kind: "run", zone: "easy", distanceM: 5000 }],
  long: [{ kind: "run", zone: "easy", distanceM: 12_000 }],
  tempo: [WARM_UP, { kind: "work", zone: "threshold", minutes: 20 }, COOL_DOWN],
  intervals: [
    WARM_UP,
    {
      repeat: 5,
      steps: [
        { kind: "work", zone: "interval", distanceM: 1000 },
        { kind: "recovery", zone: "easy", minutes: 3 },
      ],
    },
    COOL_DOWN,
  ],
  race_practice: [WARM_UP, { kind: "work", zone: "race", distanceM: 5000 }, COOL_DOWN],
};

function presetStep(step: PresetStep, units: Units): StepDraft {
  const amount =
    step.distanceM === undefined
      ? { amount: amountText(step.minutes), unit: "min" as const }
      : presetDistance(step.distanceM, units);
  return { id: draftId(), kind: step.kind, zone: step.zone, ...amount };
}

/** The type's preset steps in the runner's units. */
export function presetItems(type: CustomSessionType, units: Units): ItemDraft[] {
  return PRESETS[type].map((item) =>
    "repeat" in item
      ? {
          id: draftId(),
          repeat: String(item.repeat),
          steps: item.steps.map((step) => presetStep(step, units)),
        }
      : presetStep(item, units),
  );
}

/** A new workout on `date`: an easy run, its preset loaded and untouched. */
export function newDraft(date: string, units: Units): WorkoutDraft {
  return { date, type: "easy", title: "", items: presetItems("easy", units), edited: false };
}

/** A saved step as the form shows it: minutes, the runner's unit from one unit up, meters below it. */
function stepDraft(step: Step, units: Units): StepDraft {
  const base = { id: draftId(), kind: step.kind, zone: step.zone };
  if (step.durationS !== null)
    return { ...base, amount: amountText(step.durationS / 60), unit: "min" };
  const distanceM = step.distanceM ?? 0;
  return distanceInUnits(distanceM, units) < 1
    ? { ...base, amount: amountText(distanceM), unit: "m" }
    : { ...base, amount: amountText(distanceInUnits(distanceM, units)), unit: units };
}

/** A custom workout opened for editing: its own steps, kept when the runner picks another type. */
export function draftFromSession(session: PlanSession, units: Units): WorkoutDraft {
  return {
    date: session.date,
    // The builder only opens custom workouts, whose types are the five it offers.
    type: session.type as CustomSessionType,
    title: session.title ?? "",
    items: session.steps.map((item) =>
      "repeat" in item
        ? {
            id: draftId(),
            repeat: String(item.repeat),
            steps: item.steps.map((step) => stepDraft(step, units)),
          }
        : stepDraft(item, units),
    ),
    edited: true,
  };
}

/** Another type: its preset replaces the steps while the runner has not changed them. */
export function chooseType(
  draft: WorkoutDraft,
  type: CustomSessionType,
  units: Units,
): WorkoutDraft {
  return draft.edited ? { ...draft, type } : { ...draft, type, items: presetItems(type, units) };
}

function mapSteps(items: ItemDraft[], change: (step: StepDraft) => StepDraft): ItemDraft[] {
  return items.map((item) =>
    isRepeatDraft(item) ? { ...item, steps: item.steps.map(change) } : change(item),
  );
}

/**
 * Changes one step, wherever it is. A step that turns into a warm-up, recovery or cool-down runs open on
 * the watch, so its zone goes back to easy, which is also the pace its time is estimated at.
 */
export function updateStep(
  draft: WorkoutDraft,
  id: string,
  changes: Partial<Omit<StepDraft, "id">>,
): WorkoutDraft {
  return {
    ...draft,
    edited: true,
    items: mapSteps(draft.items, (step) => {
      if (step.id !== id) return step;
      const next = { ...step, ...changes };
      return isPacedStep(next.kind) ? next : { ...next, zone: "easy" };
    }),
  };
}

export function updateRepeat(draft: WorkoutDraft, id: string, repeat: string): WorkoutDraft {
  return {
    ...draft,
    edited: true,
    items: draft.items.map((item) =>
      item.id === id && isRepeatDraft(item) ? { ...item, repeat } : item,
    ),
  };
}

/** Removes a step or a whole repeat. A repeat keeps at least one step: its last goes with the repeat. */
export function removeItem(draft: WorkoutDraft, id: string): WorkoutDraft {
  return {
    ...draft,
    edited: true,
    items: draft.items
      .filter((item) => item.id !== id)
      .map((item) =>
        isRepeatDraft(item) && item.steps.length > 1
          ? { ...item, steps: item.steps.filter((step) => step.id !== id) }
          : item,
      ),
  };
}

/** Adds a 10 min easy run at the end, or a 400 m interval rep at the end of a repeat. */
export function addStep(draft: WorkoutDraft, repeatId?: string): WorkoutDraft {
  if (repeatId === undefined) {
    const step: StepDraft = { id: draftId(), kind: "run", zone: "easy", amount: "10", unit: "min" };
    return { ...draft, edited: true, items: [...draft.items, step] };
  }
  return {
    ...draft,
    edited: true,
    items: draft.items.map((item) =>
      item.id === repeatId && isRepeatDraft(item) && item.steps.length < REPEAT_STEPS_MAX
        ? {
            ...item,
            steps: [
              ...item.steps,
              { id: draftId(), kind: "work", zone: "interval", amount: "400", unit: "m" },
            ],
          }
        : item,
    ),
  };
}

/** Adds 4 x (400 m at interval pace, 2 min recovery) at the end. */
export function addRepeat(draft: WorkoutDraft): WorkoutDraft {
  const repeat: RepeatDraft = {
    id: draftId(),
    repeat: "4",
    steps: [
      { id: draftId(), kind: "work", zone: "interval", amount: "400", unit: "m" },
      { id: draftId(), kind: "recovery", zone: "easy", amount: "2", unit: "min" },
    ],
  };
  return { ...draft, edited: true, items: [...draft.items, repeat] };
}

type StepParse = { ok: true; step: Step } | { ok: false; problem: "amount" | "too_long" };

/** "2,5" reads like "2.5": a phone keypad in many locales types a comma. */
function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  const value = Number(trimmed);
  return trimmed !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseStep(draft: StepDraft): StepParse {
  const amount = parseAmount(draft.amount);
  if (amount === null) return { ok: false, problem: "amount" };
  const base = { kind: draft.kind, zone: draft.zone };
  if (draft.unit === "min") {
    const durationS = Math.round(amount * 60);
    if (durationS < 1) return { ok: false, problem: "amount" };
    if (durationS > STEP_MAX_DURATION_S) return { ok: false, problem: "too_long" };
    return { ok: true, step: { ...base, distanceM: null, durationS } };
  }
  const distanceM = Math.round(draft.unit === "m" ? amount : amount * metersPerUnit(draft.unit));
  if (distanceM < 1) return { ok: false, problem: "amount" };
  if (distanceM > STEP_MAX_DISTANCE_M) return { ok: false, problem: "too_long" };
  return { ok: true, step: { ...base, distanceM, durationS: null } };
}

function parseRepeat(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 2 && value <= REPEAT_MAX ? value : null;
}

type StepsParse = { ok: true; steps: SessionSteps } | { ok: false; message: string };

function stepProblem(label: string, problem: "amount" | "too_long", units: Units): string {
  if (problem === "amount") return `Enter how long step ${label} lasts, a number above zero.`;
  const distance = formatStepDistance(distanceInUnits(STEP_MAX_DISTANCE_M, units), units);
  return `Step ${label} is too long: a step lasts at most ${formatStepDuration(STEP_MAX_DURATION_S)} or ${distance}.`;
}

function parseItems(items: ItemDraft[], units: Units): StepsParse {
  const steps: (Step | Repeat)[] = [];
  for (const [position, item] of items.entries()) {
    const label = String(position + 1);
    if (!isRepeatDraft(item)) {
      const parsed = parseStep(item);
      if (!parsed.ok) return { ok: false, message: stepProblem(label, parsed.problem, units) };
      steps.push(parsed.step);
      continue;
    }
    const repeat = parseRepeat(item.repeat);
    if (repeat === null) {
      return {
        ok: false,
        message: `Repeat ${label} runs 2 to ${REPEAT_MAX} times. Change its count.`,
      };
    }
    const inner: Step[] = [];
    for (const [index, step] of item.steps.entries()) {
      const parsed = parseStep(step);
      if (!parsed.ok) {
        return { ok: false, message: stepProblem(`${label}.${index + 1}`, parsed.problem, units) };
      }
      inner.push(parsed.step);
    }
    steps.push({ repeat, steps: inner });
  }
  return { ok: true, steps };
}

/** The steps as far as they read, for the live summary: null while an amount or a count is unfinished. */
export function draftSteps(items: ItemDraft[], units: Units): SessionSteps | null {
  const parsed = parseItems(items, units);
  return parsed.ok && parsed.steps.length > 0 ? parsed.steps : null;
}

export type WorkoutInputResult =
  { ok: true; input: CustomSessionInput } | { ok: false; message: string };

/**
 * The draft as POST or PUT /api/sessions takes it, or the first thing to fix, as a sentence that says what
 * to change. Checked against customSessionInputSchema too, so the form never sends what the API refuses.
 */
export function workoutInput(draft: WorkoutDraft, units: Units, today: string): WorkoutInputResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || draft.date < today) {
    return { ok: false, message: "Pick a date from today on." };
  }
  if (draft.items.length === 0) return { ok: false, message: "Add at least one step." };
  const parsed = parseItems(draft.items, units);
  if (!parsed.ok) return parsed;
  const count = garminStepCount(parsed.steps);
  if (count > GARMIN_WORKOUT_STEPS_MAX) {
    return {
      ok: false,
      message: `This workout has ${count} steps and a watch workout holds ${GARMIN_WORKOUT_STEPS_MAX}, a repeat counting one plus its steps. Remove ${count - GARMIN_WORKOUT_STEPS_MAX}.`,
    };
  }
  const title = draft.title.trim();
  const input = customSessionInputSchema.safeParse({
    date: draft.date,
    type: draft.type,
    title: title === "" ? null : title,
    steps: parsed.steps,
  });
  return input.success
    ? { ok: true, input: input.data }
    : { ok: false, message: errorMessages.validation };
}
