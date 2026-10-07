import type { PlanDelta, PlanPaces, PlanPhase } from "@running-coach/shared";
import { daysBetween } from "../dates";
import type { DeltaSession } from "./apply-delta";
import { validateDelta, type DeltaResult } from "./delta";

/** A session of the coming week, with what the change rules read about its earlier changes. */
export interface WeekDeltaSession extends DeltaSession {
  id: string;
  /** The coach or a review already changed it. */
  coachAdjusted: boolean;
  /** A pause or gap re-entry changed it: it may shrink, never grow. */
  eased: boolean;
  /** Its plan week's phase, null for a custom workout: in a taper or race week it may only shrink. */
  phase: PlanPhase | null;
}

/** previousWeekM, longestRecentM, daysPerWeek, paces, paused and afterPause as in DeltaContext. */
export interface WeekDeltaContext {
  /** The runner's local today. */
  today: string;
  /** The coming Monday-to-Sunday week's sessions, plan and custom, any status. */
  sessions: readonly WeekDeltaSession[];
  previousWeekM: number | null;
  longestRecentM: number;
  daysPerWeek: number;
  paces: PlanPaces;
  paused: boolean;
  afterPause: boolean;
}

export interface WeekDeltaProposal {
  /** null when the label the coach used matched no session. */
  sessionId: string | null;
  delta: PlanDelta;
}

export interface WeekDeltaOutcome {
  sessionId: string | null;
  result: DeltaResult;
}

/**
 * Accepts, clamps or rejects the changes a weekly review proposed for the coming week, one outcome per
 * proposal in their order. Each goes through validateDelta in the date order of its session (ties keep
 * the proposals' order), so the result never depends on the order the coach listed them, against the
 * week as the earlier accepted changes left it: the week stays within 10% of the week before over all
 * of its rises together. A session takes one change: a second proposal for it, accepted or not, is
 * rejected adjusted, unless validateDelta names an earlier reason for the session as it came in (a
 * pause, a custom workout, a race, a locked session). A proposal naming no session of the week is
 * rejected no_session. Deterministic; conflicts are returned, never thrown.
 */
export function validateWeekDeltas(
  context: WeekDeltaContext,
  proposals: readonly WeekDeltaProposal[],
): WeekDeltaOutcome[] {
  const current = new Map(context.sessions.map((session) => [session.id, session]));
  const results: DeltaResult[] = proposals.map(() => ({ ok: false, reason: "no_session" }));
  const known = proposals.flatMap(({ sessionId, delta }, index) => {
    const session = sessionId === null ? undefined : current.get(sessionId);
    return session === undefined ? [] : [{ session, delta, index }];
  });
  // Array sort is stable, so proposals for sessions on the same date keep their order.
  known.sort((a, b) => daysBetween(b.session.date, a.session.date));
  const proposed = new Set<string>();
  for (const { session, delta, index } of known) {
    const again = proposed.has(session.id);
    // A repeat is judged on the session as it came in, as one the coach already changed: a session the
    // first proposal rested says adjusted, not locked.
    const now = again ? session : current.get(session.id)!;
    const result = validateDelta(
      {
        today: context.today,
        session: now,
        phase: now.phase,
        weekSessions: [...current.values()].filter((other) => other.id !== session.id),
        previousWeekM: context.previousWeekM,
        longestRecentM: context.longestRecentM,
        daysPerWeek: context.daysPerWeek,
        paces: context.paces,
        paused: context.paused,
        coachAdjusted: now.coachAdjusted || again,
        eased: now.eased,
        afterPause: context.afterPause,
      },
      delta,
    );
    proposed.add(session.id);
    if (result.ok) current.set(session.id, { ...now, ...result.session });
    results[index] = result;
  }
  return proposals.map(({ sessionId }, index) => ({ sessionId, result: results[index]! }));
}
