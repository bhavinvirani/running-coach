import type { AdjustedSession } from "@running-coach/engine";
import type {
  PlanPaces,
  PlanSession,
  SessionAdjustment,
  SessionSnapshot,
  Units,
} from "@running-coach/shared";
import { and, desc, inArray, sql } from "drizzle-orm";
import { planAdjustment, type PlanSessionRow } from "../db/schema";
import { type Executor, isPaused, openPause } from "./runner-state";
import { isOnGarmin } from "./workout-push-plan";

// A session row as every response carries it (GET /api/plan, /api/calendar, /api/sessions/:id), with what
// the adaptation made of it: its latest change (plan_adjustment) and whether the open pause holds it.

/** What a response's sessions read beyond their rows, looked up once for all of them. */
export interface SessionContext {
  /** The latest applied change per session id; a session never changed has none. */
  adjustments: ReadonlyMap<string, SessionAdjustment>;
  /** The open pause's start, null while training runs. */
  pausedFrom: string | null;
}

/** The fields a change shows ("Tempo 8.0 km → Easy 6.4 km"), without the steps the log also keeps. */
export function snapshotOf({ type, title, status, target }: AdjustedSession): SessionSnapshot {
  return { type, title, status, target };
}

/** What the change log stores of a session, before or after a change. */
export function adjustedOf(row: PlanSessionRow): AdjustedSession {
  return {
    type: row.type,
    title: row.title,
    status: row.status,
    steps: row.steps,
    target: row.target,
  };
}

/**
 * The context for these sessions in two queries whatever their number: the open pause, and per session
 * its latest applied or clamped change (any source) with the snapshot from before its first one, which is
 * how the plan had it. Rejected coach and review proposals changed nothing, so they are left out.
 */
export async function readSessionContext(
  executor: Executor,
  userId: string,
  sessionIds: readonly string[],
): Promise<SessionContext> {
  const pause = await openPause(executor, userId);
  const adjustments = new Map<string, SessionAdjustment>();
  if (sessionIds.length > 0) {
    const rows = await executor
      .selectDistinctOn([planAdjustment.planSessionId], {
        sessionId: planAdjustment.planSessionId,
        source: planAdjustment.source,
        kind: planAdjustment.kind,
        activityId: planAdjustment.activityId,
        createdAt: planAdjustment.createdAt,
        // Window functions run before DISTINCT ON, so this is the session's first change of all.
        original: sql<AdjustedSession | null>`first_value(${planAdjustment.before}) over (
          partition by ${planAdjustment.planSessionId}
          order by ${planAdjustment.createdAt}, ${planAdjustment.id}
        )`,
      })
      .from(planAdjustment)
      .where(
        and(
          inArray(planAdjustment.planSessionId, [...sessionIds]),
          inArray(planAdjustment.outcome, ["applied", "clamped"]),
        ),
      )
      .orderBy(
        planAdjustment.planSessionId,
        desc(planAdjustment.createdAt),
        desc(planAdjustment.id),
      );
    for (const row of rows) {
      // Every applied change stores the session as it stood before it (plan_adjustment writers).
      if (row.sessionId === null || row.original === null) {
        throw new Error("An applied plan adjustment has no session or no before");
      }
      adjustments.set(row.sessionId, {
        source: row.source,
        kind: row.kind,
        // A pause or a weekly review has no run behind it; their rows carry none.
        activityId: row.activityId,
        original: snapshotOf(row.original),
        at: row.createdAt.toISOString(),
      });
    }
  }
  return { adjustments, pausedFrom: pause?.startedOn ?? null };
}

/**
 * `paces` are the ones the session's zones read: its plan's, or the active plan's for a custom workout
 * (null without one). onGarmin compares the stored Garmin state with the workout the session makes now.
 */
export function toPlanSession(
  row: PlanSessionRow,
  paces: PlanPaces | null,
  units: Units,
  context: SessionContext,
): PlanSession {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    target: row.target,
    steps: row.steps,
    status: row.status,
    source: row.planId === null ? "custom" : "plan",
    title: row.title,
    activityId: row.activityId,
    adjustment: context.adjustments.get(row.id) ?? null,
    paused: isPaused(row, context.pausedFrom),
    onGarmin: isOnGarmin(row, paces, units),
  };
}
