import {
  goalInputSchema,
  type DistanceKey,
  type Goal,
  type GoalInput,
  type GoalKind,
  type RaceDistanceKey,
  type Weekday,
} from "@running-coach/shared";
import { errorMessages } from "@/lib/errors";
import { formatRecordTime } from "@/lib/format";
import { parseDuration } from "@/lib/parse-duration";
import { goalCopy } from "./goal-copy";

/** The goal form as typed: dates and times stay text until the form is sent. */
export type GoalForm = {
  kind: GoalKind;
  /** Null until picked for a race; null on a fitness goal means any distance. */
  distanceKey: RaceDistanceKey | null;
  /** "2026-10-25", or "" when empty. */
  raceDate: string;
  targetTime: string;
  daysPerWeek: number;
  longRunDay: Weekday;
  /** The recent race fields are out of sight until asked for, or until the plan needs a time. */
  showRecentTime: boolean;
  recentDistanceKey: DistanceKey;
  recentTime: string;
};

/** The distances a recent time can be typed for: the race distances and the mile, shortest first. */
export const RECENT_DISTANCE_KEYS = [
  "1mi",
  "5k",
  "10k",
  "half",
  "marathon",
] as const satisfies readonly DistanceKey[];

/**
 * The form for the current goal, or a new one: a race, 4 runs a week and the long run on Sunday, with the
 * distance and race date left for the runner to pick.
 */
export function goalForm(goal: Goal | null): GoalForm {
  return {
    kind: goal?.kind ?? "race",
    distanceKey: goal?.distanceKey ?? null,
    raceDate: goal?.raceDate ?? "",
    targetTime: goal?.targetTimeS ? formatRecordTime(goal.targetTimeS) : "",
    daysPerWeek: goal?.daysPerWeek ?? 4,
    longRunDay: goal?.longRunDay ?? "sun",
    showRecentTime: goal?.recentTime != null,
    recentDistanceKey: goal?.recentTime?.distanceKey ?? "5k",
    recentTime: goal?.recentTime ? formatRecordTime(goal.recentTime.timeS) : "",
  };
}

export type GoalFormResult = { ok: true; goal: GoalInput } | { ok: false; message: string };

/**
 * The body of PUT /api/goal, or the sentence that says what to fix first. Every empty optional field is
 * null, and a fitness goal never carries the race date or target time the form keeps for a switch back.
 */
export function goalInput(form: GoalForm): GoalFormResult {
  const race = form.kind === "race";
  const targetText = race ? form.targetTime.trim() : "";
  const targetTimeS = targetText === "" ? null : parseDuration(targetText);
  if (targetText !== "" && targetTimeS === null) {
    return { ok: false, message: goalCopy.badTargetTime };
  }

  const recentText = form.showRecentTime ? form.recentTime.trim() : "";
  const recentTimeS = recentText === "" ? null : parseDuration(recentText);
  if (recentText !== "" && recentTimeS === null) {
    return { ok: false, message: goalCopy.badRecentTime };
  }

  const parsed = goalInputSchema.safeParse({
    kind: form.kind,
    distanceKey: form.distanceKey,
    raceDate: race && form.raceDate !== "" ? form.raceDate : null,
    targetTimeS,
    daysPerWeek: form.daysPerWeek,
    longRunDay: form.longRunDay,
    recentTime:
      recentTimeS === null ? null : { distanceKey: form.recentDistanceKey, timeS: recentTimeS },
  });
  if (parsed.success) return { ok: true, goal: parsed.data };

  const field = parsed.error.issues[0]?.path[0];
  if (field === "distanceKey") return { ok: false, message: goalCopy.pickDistance };
  if (field === "raceDate") return { ok: false, message: goalCopy.pickRaceDate };
  return { ok: false, message: errorMessages.validation };
}
