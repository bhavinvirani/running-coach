import {
  DEFAULT_SHOE_RETIRE_DISTANCE_M,
  MAX_SHOE_RETIRE_DISTANCE_M,
  MAX_SHOE_START_DISTANCE_M,
  MIN_SHOE_RETIRE_DISTANCE_M,
  distanceInUnits,
  metersPerUnit,
  type Shoe,
  type ShoeInput,
  type Units,
} from "@running-coach/shared";
import { formatDistanceValue } from "@/lib/format";
import { shoeProblems } from "./shoe-copy";

/** The form as typed: text, so a field can be empty or half typed. Distances in the runner's unit. */
export type ShoeDraft = {
  brand: string;
  model: string;
  colour: string;
  nickname: string;
  retireAt: string;
  startDistance: string;
};

/** A new pair before anything is typed: the default goal and nothing run before the app. */
export const NEW_SHOE: ShoeInput = {
  brand: "",
  model: "",
  colour: null,
  nickname: null,
  retireDistanceM: DEFAULT_SHOE_RETIRE_DISTANCE_M,
  startDistanceM: 0,
};

/** The fields of a stored pair the form edits. */
export function inputOf(shoe: Shoe): ShoeInput {
  const { brand, model, colour, nickname, retireDistanceM, startDistanceM } = shoe;
  return { brand, model, colour, nickname, retireDistanceM, startDistanceM };
}

/**
 * The form for a pair: the goal in whole units, as the runner set it (650 km shows 404 mi), the distance
 * before the app to a tenth like any distance, or 0 when there was none.
 */
export function draftFromInput(input: ShoeInput, units: Units): ShoeDraft {
  return {
    brand: input.brand,
    model: input.model,
    colour: input.colour ?? "",
    nickname: input.nickname ?? "",
    // A field's text, not a figure: format.ts would group thousands ("1,000"), which the field would then
    // read as a decimal comma.
    retireAt: String(Math.round(distanceInUnits(input.retireDistanceM, units))),
    startDistance:
      input.startDistanceM === 0
        ? "0"
        : formatDistanceValue(distanceInUnits(input.startDistanceM, units)),
  };
}

/**
 * A distance field's text with one comma read as the decimal point, which a comma-locale keypad types for
 * inputMode decimal ("62,1"), as the workout builder reads a step's amount. A second comma stays and fails.
 */
function decimalText(text: string): string {
  return text.trim().replace(",", ".");
}

/** A distance as typed, or NaN for anything else: letters, a second point or comma, a sign. */
function parseDistance(text: string): number {
  const decimal = decimalText(text);
  return /^(\d+\.?\d*|\.\d+)$/.test(decimal) ? Number(decimal) : Number.NaN;
}

/**
 * A distance field in meters. Left as the form showed it, the stored meters stay: the field shows them
 * rounded, so converting the shown value back would move them (650000 m shows 404 mi, which is 650175 m).
 * A changed value is converted from the runner's unit to whole meters; null when it is not a number.
 */
function meters(typed: string, shown: string, storedM: number, units: Units): number | null {
  if (decimalText(typed) === shown) return storedM;
  const value = parseDistance(typed);
  return Number.isNaN(value) ? null : Math.round(value * metersPerUnit(units));
}

function optionalText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

export type CheckedShoe = { success: true; input: ShoeInput } | { success: false; message: string };

/**
 * The draft as the API takes it, checked against the shared contract first so a problem is said in the
 * runner's unit before anything is sent. `stored` is what the form was taken from (NEW_SHOE for a new
 * pair): a distance left as shown keeps its meters.
 */
export function checkDraft(draft: ShoeDraft, stored: ShoeInput, units: Units): CheckedShoe {
  const problems = shoeProblems(units);
  const shown = draftFromInput(stored, units);
  const brand = draft.brand.trim();
  const model = draft.model.trim();
  if (brand === "") return { success: false, message: problems.brand };
  if (model === "") return { success: false, message: problems.model };

  const retireDistanceM = meters(draft.retireAt, shown.retireAt, stored.retireDistanceM, units);
  if (
    retireDistanceM === null ||
    retireDistanceM < MIN_SHOE_RETIRE_DISTANCE_M ||
    retireDistanceM > MAX_SHOE_RETIRE_DISTANCE_M
  ) {
    return { success: false, message: problems.retireAt };
  }

  // Blank means the pair ran nothing before the app.
  const startText = draft.startDistance.trim() === "" ? "0" : draft.startDistance;
  const startDistanceM = meters(startText, shown.startDistance, stored.startDistanceM, units);
  if (startDistanceM === null || startDistanceM > MAX_SHOE_START_DISTANCE_M) {
    return { success: false, message: problems.startDistance };
  }

  return {
    success: true,
    input: {
      brand,
      model,
      colour: optionalText(draft.colour),
      nickname: optionalText(draft.nickname),
      retireDistanceM,
      startDistanceM,
    },
  };
}
