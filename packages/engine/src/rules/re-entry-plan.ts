import type {
  PlanPaces,
  SessionSource,
  SessionStatus,
  SessionSteps,
  SessionTarget,
  SessionType,
} from "@running-coach/shared";
import { REPEAT_MAX } from "@running-coach/shared";
import {
  RE_ENTRY_EASY_DAYS,
  WALK_RUN_MIN_REPEATS,
  WALK_RUN_RUN_S,
  WALK_RUN_TITLE,
  WALK_RUN_WALK_S,
  WEEKLY_VOLUME_MAX_INCREASE,
} from "../constants";
import { daysBetween, mondayOf } from "../dates";
import { applyDelta, sameSession, type AdjustedSession } from "./apply-delta";
import { QUALITY_SESSION_TYPES } from "./quality";
import { reEntryFactor } from "./re-entry";
import { hasExtras, plainRunSteps } from "./scale-session";
import { sessionTarget } from "./session-target";

export interface ReEntrySession {
  id: string;
  date: string;
  type: SessionType;
  status: SessionStatus;
  source: SessionSource;
  title: string | null;
  steps: SessionSteps;
  target: SessionTarget;
}

export interface ReEntryInput {
  /** The first day back, a local date. */
  fromDate: string;
  /** Whole days from the last run to fromDate. */
  daysOff: number;
  /** After illness or injury: the first 7 days are walk-run. */
  walkRun: boolean;
  /**
   * The share of volume the plan's first week already carries when the plan was built during the
   * break (the API passes baselineReEntryFactor of its baseline), in (0, 1]; 1 by default, nothing.
   */
  carriedFactor?: number;
  /** The active plan's sessions and the custom workouts, any dates and statuses. */
  sessions: readonly ReEntrySession[];
  paces: PlanPaces;
}

export interface ReEntryChange {
  id: string;
  session: AdjustedSession;
}

export interface ReEntryResult {
  /**
   * The share of planned volume the first week back runs at: reEntryFactor of the days off (1, 0.7 or
   * 0.5) over the carried factor, at most 1.
   */
  factor: number;
  /** The sessions that change, in date order. */
  changes: ReEntryChange[];
}

/** Strength sessions are not running volume; the race is never changed. */
const RUN_TYPES: ReadonlySet<SessionType> = new Set([
  "easy",
  "long",
  "intervals",
  "tempo",
  "race_practice",
]);

/**
 * Each week's share of its plan from the return on: the first week with plan volume is held to the
 * factor, each later week rises at most 10% over the one before (T_k = min(P_k, 1.1 T_k-1)), and the
 * first week that meets its plan ends the list. P is the week's sessions that are not skipped or
 * missed, custom ones included, except that the first week counts every session before the return
 * as planned: the days the break took are not volume the runner lost from the base. A week of custom
 * workouts only counts for nothing: before the plan's first week one 5 km custom run would hold the
 * plan to factor x 5 km plus 10% a week, and mid-ramp it would end the ramp a week early.
 */
function weekRatios(
  fromDate: string,
  factor: number,
  sessions: readonly ReEntrySession[],
): Map<string, number> {
  const firstMonday = mondayOf(fromDate);
  const plannedM = new Map<string, number>();
  const planM = new Map<string, number>();
  for (const session of sessions) {
    const monday = mondayOf(session.date);
    const counts =
      daysBetween(fromDate, session.date) < 0 ||
      (session.status !== "skipped" && session.status !== "missed");
    if (counts && daysBetween(firstMonday, monday) >= 0) {
      plannedM.set(monday, (plannedM.get(monday) ?? 0) + session.target.distanceM);
      if (session.source === "plan") {
        planM.set(monday, (planM.get(monday) ?? 0) + session.target.distanceM);
      }
    }
  }
  const ratios = new Map<string, number>();
  let targetM: number | null = null;
  for (const [monday, weekM] of [...plannedM].sort(([a], [b]) => daysBetween(b, a))) {
    // A week without plan runs (custom workouts only) neither sets the base, ends the ramp nor raises it.
    if (!planM.get(monday)) continue;
    targetM =
      targetM === null
        ? factor * weekM
        : Math.min(weekM, targetM * (1 + WEEKLY_VOLUME_MAX_INCREASE));
    if (targetM >= weekM) break;
    ratios.set(monday, targetM / weekM);
  }
  return ratios;
}

/** 4 min run and 1 min walk, as many rounds as fit the session's time, 2 to 50. */
function walkRun(durationS: number, paces: PlanPaces, status: SessionStatus): AdjustedSession {
  const roundS = WALK_RUN_RUN_S + WALK_RUN_WALK_S;
  const repeat = Math.min(
    Math.max(Math.floor(durationS / roundS), WALK_RUN_MIN_REPEATS),
    REPEAT_MAX,
  );
  const steps: SessionSteps = [
    {
      repeat,
      steps: [
        { kind: "run", zone: "easy", distanceM: null, durationS: WALK_RUN_RUN_S },
        { kind: "recovery", zone: "easy", distanceM: null, durationS: WALK_RUN_WALK_S },
      ],
    },
  ];
  return {
    type: "easy",
    title: WALK_RUN_TITLE,
    status,
    steps,
    target: sessionTarget(steps, paces),
  };
}

/**
 * The plan eased for a return after time off. The first week back runs at reEntryFactor of its plan
 * (1 under 7 days off, 0.7 from 7, 0.5 from 14) over what a plan built during the break already
 * carries, at most 1, so one break is never eased twice: 15 days off over a plan built at 0.7 runs at
 * 0.5 / 0.7, 9 days off over it as planned. Each later week runs at most 10% over the one before until
 * a week meets its plan, which it and every week after run as planned. In the first 7 days, when the
 * factor is under 1 or after illness or injury, quality becomes an easy run of the same time and an
 * easy or long run with strides or a finish one plain easy run of the same distance, its type kept, so
 * those days run nothing faster than easy; after illness or injury every run of those days is walk-run
 * of the session's time once cut, never longer than planned. Later cuts merge extras as scaleSession
 * does; a week that meets its plan keeps them. Only plan runs from the return on that are planned or
 * moved change: the race, custom workouts, done, missed and skipped sessions never do. Returns the
 * sessions that differ, in date order; deterministic. A carried factor outside (0, 1] is a programmer
 * error.
 */
export function reEntryPlan({
  fromDate,
  daysOff,
  walkRun: afterIllness,
  carriedFactor = 1,
  sessions,
  paces,
}: ReEntryInput): ReEntryResult {
  if (!Number.isFinite(carriedFactor) || carriedFactor <= 0 || carriedFactor > 1) {
    throw new RangeError(`carriedFactor must be finite and in (0, 1], got ${carriedFactor}`);
  }
  const factor = Math.min(1, reEntryFactor(daysOff) / carriedFactor);
  if (factor === 1 && !afterIllness) return { factor, changes: [] };
  const ratios = weekRatios(fromDate, factor, sessions);
  const changes = sessions
    .filter(
      (session) =>
        session.source === "plan" &&
        (session.status === "planned" || session.status === "moved") &&
        RUN_TYPES.has(session.type) &&
        daysBetween(fromDate, session.date) >= 0,
    )
    .sort((a, b) => daysBetween(b.date, a.date))
    .flatMap((session) => {
      const firstDays = daysBetween(fromDate, session.date) < RE_ENTRY_EASY_DAYS;
      const easedDays = firstDays && (afterIllness || factor < 1);
      let after: AdjustedSession = session;
      if (easedDays && QUALITY_SESSION_TYPES.has(session.type)) {
        after = applyDelta({ ...session, ...after }, { kind: "easy" }, paces);
      } else if (easedDays && hasExtras(session.steps)) {
        const steps = plainRunSteps(session.steps, paces);
        after = { ...after, steps, target: sessionTarget(steps, paces) };
      }
      const ratio = ratios.get(mondayOf(session.date));
      if (ratio !== undefined) {
        after = applyDelta({ ...session, ...after }, { kind: "scale", factor: ratio }, paces);
      }
      if (firstDays && afterIllness) {
        // A plain run of the same distance takes longer than strides or a finish did.
        const timeS = Math.min(after.target.durationS, session.target.durationS);
        after = walkRun(timeS, paces, after.status);
      }
      return sameSession(session, after) ? [] : [{ id: session.id, session: after }];
    });
  return { factor, changes };
}
