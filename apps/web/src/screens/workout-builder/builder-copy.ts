import { SESSION_TITLE_MAX } from "@running-coach/shared";
import { formatCountValue } from "@/lib/format";
import type { AmountUnit } from "./workout-draft";

/** Every sentence and label of the workout builder, so the wording is read and changed in one place. */
export const builderCopy = {
  newTitle: "New workout",
  editTitle: "Edit workout",
  loading: "Loading the workout builder",
  workout: "Workout",
  date: "Date",
  type: "Type",
  title: "Title",
  titleHelp: `Optional, up to ${formatCountValue(SESSION_TITLE_MAX)} characters. Your watch shows it.`,
  steps: "Steps",
  summary: "Summary",
  addStep: "Add step",
  addRepeat: "Add repeat",
  remove: "Remove",
  times: "times",
  save: "Save workout",
  saving: "Saving…",
  setGoal: "Set goal",
  /** Edit opened on a plan session: only the runner's own workouts are built here. */
  notCustom: "Only workouts you built can be edited. Move or skip plan sessions from their screen.",
  openSession: "Open session",
  stepLabel: (label: string) => `Step ${label}`,
  kindOf: (label: string) => `Kind of step ${label}`,
  amountOf: (label: string) => `Amount of step ${label}`,
  unitOf: (label: string) => `Unit of step ${label}`,
  zoneOf: (label: string) => `Zone of step ${label}`,
  removeStep: (label: string) => `Remove step ${label}`,
  timesOf: (label: string) => `Times to repeat ${label}`,
  removeRepeat: (label: string) => `Remove repeat ${label}`,
  addStepTo: (label: string) => `Add step to repeat ${label}`,
} as const;

const UNIT_LABELS: Readonly<Record<AmountUnit, string>> = {
  min: "min",
  km: "km",
  mi: "mi",
  m: "m",
};

export function amountUnitLabel(unit: AmountUnit): string {
  return UNIT_LABELS[unit];
}
