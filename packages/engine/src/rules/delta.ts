import type {
  DeltaRejection,
  PlanDelta,
  PlanPaces,
  PlanPhase,
  SessionStatus,
  SessionTarget,
  SessionType,
} from "@running-coach/shared";
import { DELTA_MAX_FACTOR, DELTA_MIN_FACTOR, FLOAT_TOLERANCE, LONG_RUN_MAX_S } from "../constants";
import { daysBetween } from "../dates";
import { applyDelta, sameSession, type AdjustedSession, type DeltaSession } from "./apply-delta";
import { longRunShare, maxRunM } from "./long-run";
import { QUALITY_SESSION_TYPES } from "./quality";
import { scaleSession } from "./scale-session";
import { bandMidpointSPerKm, distanceForDurationM } from "./session-target";
import { maxWeeklyVolumeM } from "./weekly-volume";

export interface DeltaWeekSession {
  date: string;
  type: SessionType;
  status: SessionStatus;
  target: SessionTarget;
}

export interface DeltaContext {
  /** The runner's local today. */
  today: string;
  /** The next session after the run; null when nothing is planned. */
  session: DeltaSession | null;
  /**
   * The phase of the plan week the session falls in; null for a custom workout. A taper or race-week
   * session may shrink, never grow.
   */
  phase: PlanPhase | null;
  /** The other sessions of its Monday-to-Sunday week, any status. */
  weekSessions: readonly DeltaWeekSession[];
  /**
   * Planned distance of the week before, skipped sessions left out: null when the session's week has
   * no week before it in the plan (no weekly cap), 0 when the week before runs nothing (no rise).
   */
  previousWeekM: number | null;
  /** The longest actual run of the last 30 days, 0 with none. */
  longestRecentM: number;
  daysPerWeek: number;
  paces: PlanPaces;
  /** The runner has an open pause. */
  paused: boolean;
  /** The coach already changed this session. */
  coachAdjusted: boolean;
  /** A pause or gap re-entry changed this session: it may shrink, never grow. */
  eased: boolean;
  /**
   * The session's Monday-to-Sunday week follows a week a pause covered (at least one paused day in the
   * week before): it may shrink, never grow, as an eased session.
   */
  afterPause: boolean;
}

export type DeltaResult =
  | {
      ok: true;
      /** As applied: a scale's factor is the one actually used, after the caps. */
      delta: PlanDelta;
      /** The engine pulled the proposal inside its caps. */
      clamped: boolean;
      session: AdjustedSession;
    }
  | { ok: false; reason: DeltaRejection };

const OPEN_STATUSES: ReadonlySet<SessionStatus> = new Set(["planned", "moved"]);

function rejection(context: DeltaContext, delta: PlanDelta): DeltaRejection | null {
  const { session } = context;
  if (session === null) return "no_session";
  if (context.paused) return "paused";
  if (session.source === "custom") return "custom";
  if (session.type === "race") return "race";
  if (!OPEN_STATUSES.has(session.status) || daysBetween(context.today, session.date) < 0) {
    return "locked";
  }
  if (context.coachAdjusted) return "adjusted";
  if (delta.kind === "scale" && !Number.isFinite(delta.factor)) return "invalid";
  return null;
}

/**
 * The longest the session may grow to: 110% of the longest recent run, for a long run its share of the
 * week (L <= share x (others + L)) and 150 min easy, and the week within 10% of the week before (no
 * such cap in the plan's first week). The week's skipped and missed sessions do not count. Never under
 * the planned run: the caps stop a rise, they do not cut. No rise at all without a run in 30 days or
 * after a week that runs nothing.
 */
function riseCapM(context: DeltaContext, session: DeltaSession): number {
  const plannedM = session.target.distanceM;
  if (context.longestRecentM <= 0 || context.previousWeekM === 0) return plannedM;
  const othersM = context.weekSessions
    .filter((other) => other.status !== "skipped" && other.status !== "missed")
    .reduce((sum, other) => sum + other.target.distanceM, 0);
  const caps = [maxRunM(context.longestRecentM)];
  if (session.type === "long") {
    const share = longRunShare(context.daysPerWeek);
    caps.push(
      (share * othersM) / (1 - share),
      distanceForDurationM(LONG_RUN_MAX_S, bandMidpointSPerKm(context.paces.easy)),
    );
  }
  if (context.previousWeekM !== null) {
    caps.push(maxWeeklyVolumeM(context.previousWeekM) - othersM);
  }
  return Math.max(plannedM, Math.min(...caps));
}

/** The factor a scale runs at after the caps, and whether the caps moved it. */
function cappedFactor(
  context: DeltaContext,
  session: DeltaSession,
  proposed: number,
): { factor: number; clamped: boolean } {
  const bounded = Math.min(Math.max(proposed, DELTA_MIN_FACTOR), DELTA_MAX_FACTOR);
  const shrinkOnly =
    context.eased ||
    context.afterPause ||
    context.phase === "taper" ||
    context.phase === "race" ||
    QUALITY_SESSION_TYPES.has(session.type);
  const factor = shrinkOnly ? Math.min(bounded, 1) : bounded;
  const clamped = factor !== proposed;
  const plannedM = session.target.distanceM;
  if (factor <= 1 || plannedM === 0) return { factor, clamped };
  const wantedM = plannedM * factor;
  const allowedM = Math.min(wantedM, riseCapM(context, session));
  return {
    factor: allowedM / plannedM,
    clamped: clamped || wantedM - allowedM > FLOAT_TOLERANCE,
  };
}

/**
 * Accepts, clamps or rejects a change the coach proposed for the next session. It is rejected for no
 * session, a pause, a custom workout, a race, a past or locked session, a session the coach already
 * changed, or a scale without a usable factor, in that order, and when it would leave the session as
 * it is. A scale is clamped to 0.5 to 1.1; a quality session, a session a re-entry eased, any session
 * in the week right after a paused week and any session of a taper or race week only shrink (a rise
 * clamps to 1, so a pure rise changes nothing); a rise of an easy or long run also stops at 110% of the
 * longest recent run, the long-run share and 150 min, and 10% over last week, with none after a week
 * that runs nothing, and grows only its easy run, never strides or a finish; a cut stops at the 20 min
 * minimum run and merges strides or a finish into one easy run. easy only applies to quality; rest
 * skips the session.
 * Deterministic; conflicts are returned, never thrown.
 */
export function validateDelta(context: DeltaContext, delta: PlanDelta): DeltaResult {
  const reason = rejection(context, delta);
  if (reason !== null) return { ok: false, reason };
  const session = context.session!;
  const before: AdjustedSession = session;
  let applied = delta;
  let clamped = false;
  if (delta.kind === "easy" && !QUALITY_SESSION_TYPES.has(session.type)) {
    return { ok: false, reason: "no_change" };
  }
  if (delta.kind === "scale") {
    const capped = cappedFactor(context, session, delta.factor);
    applied = { kind: "scale", factor: capped.factor };
    clamped =
      capped.clamped ||
      scaleSession({ steps: session.steps, factor: capped.factor, paces: context.paces }).atMinimum;
  }
  const after = applyDelta(session, applied, context.paces);
  if (sameSession(before, after)) return { ok: false, reason: "no_change" };
  return { ok: true, delta: applied, clamped, session: after };
}
