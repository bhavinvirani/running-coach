import {
  STEP_MAX_DISTANCE_M,
  type PlanDelta,
  type PlanPaces,
  type SessionSource,
  type SessionStatus,
  type SessionSteps,
  type SessionTarget,
  type SessionType,
  type Step,
} from "@running-coach/shared";
import { SCALE_DISTANCE_STEP_M } from "../constants";
import { scaleSteps } from "./scale-session";
import { bandMidpointSPerKm, distanceForDurationM, sessionTarget } from "./session-target";
import { minRunDistanceM } from "./week-fill";

/** A session as the plan holds it, with what the change rules read. */
export interface DeltaSession {
  date: string;
  type: SessionType;
  status: SessionStatus;
  source: SessionSource;
  title: string | null;
  steps: SessionSteps;
  target: SessionTarget;
}

/** A session after a change: what the API writes back to its row. */
export interface AdjustedSession {
  type: SessionType;
  title: string | null;
  status: SessionStatus;
  steps: SessionSteps;
  target: SessionTarget;
}

/**
 * One easy run of the session's time at the easy midpoint, floored to whole 100 m: at least 20 min,
 * but never longer than the session it replaces, so turning a session easy never adds load.
 */
function easyRunSteps(target: SessionTarget, paces: PlanPaces): SessionSteps {
  const easyPaceSPerKm = bandMidpointSPerKm(paces.easy);
  const sameTimeM =
    Math.floor(distanceForDurationM(target.durationS, easyPaceSPerKm) / SCALE_DISTANCE_STEP_M) *
    SCALE_DISTANCE_STEP_M;
  const distanceM = Math.min(
    Math.max(sameTimeM, minRunDistanceM(easyPaceSPerKm)),
    target.distanceM,
    STEP_MAX_DISTANCE_M,
  );
  return [{ kind: "run", zone: "easy", distanceM, durationS: null }];
}

/**
 * The session with the change made, no questions asked: validateDelta decides whether it may be made
 * and clamps the factor first. rest skips it as planned; easy makes it one easy run of the same time;
 * scale sizes its steps (a quality session loses reps instead). The target follows the steps.
 */
export function applyDelta(
  session: DeltaSession,
  delta: PlanDelta,
  paces: PlanPaces,
): AdjustedSession {
  const { type, title, status, steps, target } = session;
  switch (delta.kind) {
    case "rest":
      return { type, title, status: "skipped", steps, target };
    case "easy": {
      const easy = easyRunSteps(target, paces);
      return { type: "easy", title: null, status, steps: easy, target: sessionTarget(easy, paces) };
    }
    case "scale": {
      const scaled = scaleSteps({ steps, factor: delta.factor, paces });
      return { type, title, status, steps: scaled, target: sessionTarget(scaled, paces) };
    }
  }
}

function sameStep(a: Step, b: Step): boolean {
  return (
    a.kind === b.kind &&
    a.zone === b.zone &&
    a.distanceM === b.distanceM &&
    a.durationS === b.durationS
  );
}

function sameSteps(a: SessionSteps, b: SessionSteps): boolean {
  return (
    a.length === b.length &&
    a.every((item, k) => {
      const other = b[k]!;
      if ("repeat" in item !== "repeat" in other) return false;
      if ("repeat" in item && "repeat" in other) {
        return (
          item.repeat === other.repeat &&
          item.steps.length === other.steps.length &&
          item.steps.every((step, j) => sameStep(step, other.steps[j]!))
        );
      }
      return sameStep(item as Step, other as Step);
    })
  );
}

/**
 * Whether a change left the session as it was: same type, title, status and steps (the target follows
 * the steps). Field by field, so steps read back from jsonb in another key order still compare equal.
 */
export function sameSession(a: AdjustedSession, b: AdjustedSession): boolean {
  return (
    a.type === b.type && a.title === b.title && a.status === b.status && sameSteps(a.steps, b.steps)
  );
}
