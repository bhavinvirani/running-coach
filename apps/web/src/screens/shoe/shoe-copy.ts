import {
  DEFAULT_SHOE_RETIRE_DISTANCE_M,
  MAX_SHOE_RETIRE_DISTANCE_M,
  MAX_SHOE_START_DISTANCE_M,
  MIN_SHOE_RETIRE_DISTANCE_M,
  distanceInUnits,
  type Units,
} from "@running-coach/shared";
import { formatWholeDistance, formatWholeDistanceValue } from "@/lib/format";

export const shoeCopy = {
  newTitle: "New shoes",
  editTitle: "Edit shoes",
  loading: "Loading shoes",
  pair: "Pair",
  brand: "Brand",
  model: "Model",
  colour: "Colour",
  colourHelp: "Optional.",
  nickname: "Nickname",
  nicknameHelp: "Optional. Shown in place of brand and model.",
  distance: "Distance",
  retireAt: "Retire at",
  startDistance: "Distance before this app",
  useForNewRuns: "Use for new runs",
  add: "Add shoes",
  adding: "Adding shoes…",
  save: "Save shoes",
  saving: "Saving shoes…",
  saved: "Shoes saved.",
  makeActive: "Make active",
  makingActive: "Making active…",
  retire: "Retire shoes",
  retiring: "Retiring shoes…",
  remove: "Delete shoes",
  removing: "Deleting shoes…",
  keep: "Keep shoes",
  removeQuestion: "Delete these shoes? Their runs stay and lose their pair.",
  removed: "Shoes deleted.",
  notFound: "These shoes are not in your list. They may have been deleted.",
  allShoes: "Go to Shoes",
} as const;

const unitWords: Record<Units, string> = { km: "kilometers", mi: "miles" };

/** The helper under Retire at, with the default goal in the runner's unit. */
export function retireHelp(units: Units): string {
  const typical = formatWholeDistance(
    distanceInUnits(DEFAULT_SHOE_RETIRE_DISTANCE_M, units),
    units,
  );
  return `In ${unitWords[units]}. Running shoes lose their cushioning at about ${typical}.`;
}

/** The helper under Distance before this app. */
export function startDistanceHelp(units: Units): string {
  return `In ${unitWords[units]}. What the pair ran before this app counted its runs.`;
}

/** Where a pair stands, under the form of its screen. */
export const statusLines = {
  Active: "Active: new runs from Garmin get these shoes.",
  "In use": "In use. Make active to put them on new runs.",
  Retired: "Retired. Make active to wear them again.",
} as const;

/**
 * A range of whole units inside the meters the contract takes: from the first whole unit at or above the
 * least to the last at or below the most, so every number in it is accepted.
 */
function wholeRange(minM: number, maxM: number, units: Units): string {
  const from = Math.ceil(distanceInUnits(minM, units));
  const to = Math.floor(distanceInUnits(maxM, units));
  return `from ${formatWholeDistanceValue(from)} to ${formatWholeDistance(to, units)}`;
}

/** Why Add shoes or Save shoes sent nothing: the first problem with what is typed, naming the field. */
export function shoeProblems(units: Units) {
  return {
    brand: "Type the brand.",
    model: "Type the model.",
    retireAt: `Retire at is a distance ${wholeRange(MIN_SHOE_RETIRE_DISTANCE_M, MAX_SHOE_RETIRE_DISTANCE_M, units)}.`,
    startDistance: `Distance before this app is a distance ${wholeRange(0, MAX_SHOE_START_DISTANCE_M, units)}.`,
  };
}
