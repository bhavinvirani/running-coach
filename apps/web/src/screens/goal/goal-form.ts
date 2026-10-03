import {
  goalInputSchema,
  recentTimeSchema,
  type DistanceKey,
  type Goal,
  type GoalInput,
  type GoalKind,
  type RaceDistanceKey,
  type Weekday,
} from "@running-coach/shared";
import { addDays } from "@/lib/dates";
import { durationParts, durationSeconds, type DurationParts } from "@/lib/duration-parts";
import { errorMessages } from "@/lib/errors";
import { goalCopy } from "./goal-copy";

/** The goal form as picked: the date stays text and the times stay parts until the form is sent. */
export type GoalForm = {
  kind: GoalKind;
  /** Null until picked for a race; null on a fitness goal means any distance. */
  distanceKey: RaceDistanceKey | null;
  /** "2026-10-25", or "" when empty. */
  raceDate: string;
  /** "No target": the form sends null and keeps the picked time for when the box is unticked. */
  noTargetTime: boolean;
  targetTime: DurationParts;
  daysPerWeek: number;
  longRunDay: Weekday;
  /** The recent race fields are out of sight until asked for, or until the plan needs a time. */
  showRecentTime: boolean;
  recentDistanceKey: DistanceKey;
  /** 0:00:00 is no time: the recent race stays optional. */
  recentTime: DurationParts;
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
 * The form for the current goal, or a new one: a race with no target time, 4 runs a week and the long run
 * on Sunday, with the distance and race date left for the runner to pick.
 */
export function goalForm(goal: Goal | null): GoalForm {
  return {
    kind: goal?.kind ?? "race",
    distanceKey: goal?.distanceKey ?? null,
    raceDate: goal?.raceDate ?? "",
    noTargetTime: goal?.targetTimeS == null,
    targetTime: durationParts(goal?.targetTimeS ?? 0),
    daysPerWeek: goal?.daysPerWeek ?? 4,
    longRunDay: goal?.longRunDay ?? "sun",
    showRecentTime: goal?.recentTime != null,
    recentDistanceKey: goal?.recentTime?.distanceKey ?? "5k",
    recentTime: durationParts(goal?.recentTime?.timeS ?? 0),
  };
}

/**
 * Days from today to the last race date the picker offers. A plan runs at most 52 weeks from its first
 * Monday, which is up to 6 days off; a date typed past the engine's exact limit gets race_too_far.
 */
export const RACE_DATE_MAX_DAYS = 52 * 7 + 6;

/** The race date picker's max, "2027-10-07" on 2 Oct 2026. */
export function latestRaceDate(today: string): string {
  return addDays(today, RACE_DATE_MAX_DAYS);
}

/**
 * Where a sentence about the form shows: under the recent time's pickers, for a time no run could take,
 * or above Save goal for anything else.
 */
export type GoalFormField = "recentTime" | "goal";

export type GoalFormResult =
  { ok: true; goal: GoalInput } | { ok: false; field: GoalFormField; message: string };

/**
 * The body of PUT /api/goal, or the sentence that says what to fix first. Every empty optional field is
 * null, and a fitness goal never carries the race date or target time the form keeps for a switch back.
 * A target of 0:00:00 with No target unticked asks for a time; a recent time of 0:00:00 is no time, and
 * one at a pace no run could hold is refused here with the contract's own sentence instead of by the API.
 */
export function goalInput(form: GoalForm): GoalFormResult {
  const race = form.kind === "race";
  const targetTimeS = race && !form.noTargetTime ? durationSeconds(form.targetTime) : null;
  if (targetTimeS === 0) {
    return { ok: false, field: "goal", message: goalCopy.pickTargetTime };
  }

  // The recent time is checked on its own: a refused one would stop zod before the goal's own checks,
  // and the form asks about the fields from the top down.
  const parsed = goalInputSchema.safeParse({
    kind: form.kind,
    distanceKey: form.distanceKey,
    raceDate: race && form.raceDate !== "" ? form.raceDate : null,
    targetTimeS,
    daysPerWeek: form.daysPerWeek,
    longRunDay: form.longRunDay,
    recentTime: null,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const message =
      field === "distanceKey"
        ? goalCopy.pickDistance
        : field === "raceDate"
          ? goalCopy.pickRaceDate
          : errorMessages.validation;
    return { ok: false, field: "goal", message };
  }

  const recentSeconds = form.showRecentTime ? durationSeconds(form.recentTime) : 0;
  if (recentSeconds === 0) return { ok: true, goal: parsed.data };
  const checked = recentTimeSchema.safeParse({
    distanceKey: form.recentDistanceKey,
    timeS: recentSeconds,
  });
  if (!checked.success) {
    const message = checked.error.issues[0]?.message ?? errorMessages.validation;
    return { ok: false, field: "recentTime", message };
  }
  return { ok: true, goal: { ...parsed.data, recentTime: checked.data } };
}
