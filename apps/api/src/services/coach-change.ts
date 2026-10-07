import {
  type DeltaContext,
  type DeltaResult,
  LONGEST_RUN_LOOKBACK_DAYS,
  validateDelta,
} from "@running-coach/engine";
import type {
  AdjustmentOutcome,
  DeltaRejection,
  PlanChange,
  PlanDelta,
} from "@running-coach/shared";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, max, or, sql } from "drizzle-orm";
import { type DbTransaction, db } from "../db/client";
import {
  activity,
  goal,
  planAdjustment,
  type PlanAdjustmentRow,
  type PlanRow,
  planSession,
  type PlanSessionRow,
} from "../db/schema";
import { addDays, mondayOf } from "../lib/local-date";
import { logger } from "../lib/logger";
import { runDate, runDateWithin } from "./run-dates";
import { activePlan, type Executor, openPause, runnerToday } from "./runner-state";
import { adjustedOf, snapshotOf } from "./session-view";

// The coach's change to the plan after a run (SPEC: Plan engine, slice 9): which session it may change,
// asked before the Claude call so the prompt can say whether a change is allowed, and the change itself,
// which the engine's validateDelta accepts, clamps or rejects. Every proposal is logged in plan_adjustment,
// one per run, so the insight job retrying applies nothing twice.

const log = logger.child({ module: "coach-change" });

/** Only the runner's newest run, and only one from the last 7 days, may change the plan (SPEC). */
export const COACH_CHANGE_RUN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCEPTED: AdjustmentOutcome[] = ["applied", "clamped"];

/**
 * The first session after the run's local date and not before the runner's today, planned or moved, of
 * the active plan or custom, plan sessions first on a day: the "next session" of the coach's prompt and
 * the one its change is for. `lock` takes the row FOR UPDATE.
 */
export async function nextSessionAfter(
  executor: Executor,
  input: { userId: string; activePlanId: string; runDate: string; today: string; lock?: boolean },
): Promise<PlanSessionRow | null> {
  const query = executor
    .select()
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, input.userId),
        or(eq(planSession.planId, input.activePlanId), isNull(planSession.planId)),
        gt(planSession.date, input.runDate),
        gte(planSession.date, input.today),
        inArray(planSession.status, ["planned", "moved"]),
      ),
    )
    .orderBy(asc(planSession.date), sql`${planSession.planId} is null`, asc(planSession.id))
    .limit(1);
  const [row] = input.lock ? await query.for("update") : await query;
  return row ?? null;
}

/**
 * What the engine reads around the session: its week; the week before's planned distance, skipped and
 * missed sessions left out (none in the plan's first week, which has no week before it); recent runs; the
 * goal; and the changes already made to it, by the coach or by a pause or gap re-entry (eased).
 */
async function deltaContext(
  executor: Executor,
  {
    userId,
    active,
    session,
    today,
  }: { userId: string; active: PlanRow; session: PlanSessionRow; today: string },
): Promise<DeltaContext> {
  const monday = mondayOf(session.date);
  const around = await executor
    .select({
      id: planSession.id,
      date: planSession.date,
      type: planSession.type,
      status: planSession.status,
      target: planSession.target,
    })
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        or(eq(planSession.planId, active.id), isNull(planSession.planId)),
        gte(planSession.date, addDays(monday, -7)),
        lte(planSession.date, addDays(monday, 6)),
      ),
    );
  const weekSessions = around
    .filter((other) => other.date >= monday && other.id !== session.id)
    .map(({ date, type, status, target }) => ({ date, type, status, target }));
  const previousWeekM =
    monday <= mondayOf(active.startDate)
      ? null
      : around
          .filter(
            (other) =>
              other.date < monday && other.status !== "skipped" && other.status !== "missed",
          )
          .reduce((sum, other) => sum + other.target.distanceM, 0);
  // As the plan's baseline reads it: measured runs only, a typed-in distance is not a measured one.
  const [longest] = await executor
    .select({ distanceM: max(activity.distanceM) })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        eq(activity.isManual, false),
        runDateWithin(addDays(today, 1 - LONGEST_RUN_LOOKBACK_DAYS), today),
      ),
    );
  const [goalRow] = await executor
    .select({ daysPerWeek: goal.daysPerWeek })
    .from(goal)
    .where(eq(goal.id, active.goalId));
  const changedBy = await executor
    .selectDistinct({ source: planAdjustment.source })
    .from(planAdjustment)
    .where(
      and(eq(planAdjustment.planSessionId, session.id), inArray(planAdjustment.outcome, ACCEPTED)),
    );
  return {
    today,
    session: {
      ...adjustedOf(session),
      date: session.date,
      source: session.planId === null ? "custom" : "plan",
    },
    weekSessions,
    previousWeekM,
    longestRecentM: Math.round(longest?.distanceM ?? 0),
    daysPerWeek: goalRow?.daysPerWeek ?? active.inputs.goal.daysPerWeek,
    paces: active.paces,
    // The caller found no open pause.
    paused: false,
    coachAdjusted: changedBy.some(({ source }) => source === "coach"),
    eased: changedBy.some(({ source }) => source === "pause" || source === "gap"),
  };
}

type Target =
  | { ok: false; reason: DeltaRejection; runFound: boolean }
  | { ok: true; session: PlanSessionRow; context: DeltaContext };

/**
 * The session the coach may change after this run, with the engine's context for it. stale_run unless
 * the run is the runner's newest (by UTC start) and started within the last 7 days; paused during a
 * pause; no_session without an active plan, for a run before the plan's start (the prompt shows no plan
 * for it), or with no next session.
 */
async function resolveTarget(
  executor: Executor,
  {
    userId,
    activityId,
    now,
    lock,
  }: { userId: string; activityId: string; now: Date; lock: boolean },
): Promise<Target> {
  const today = await runnerToday(executor, userId, now);
  const [run] = await executor
    .select({ id: activity.id, startUtc: activity.startUtc, date: runDate })
    .from(activity)
    .where(and(eq(activity.id, activityId), eq(activity.userId, userId)));
  if (!run) return { ok: false, reason: "stale_run", runFound: false };
  const [newest] = await executor
    .select({ id: activity.id })
    .from(activity)
    .where(eq(activity.userId, userId))
    .orderBy(desc(activity.startUtc), desc(activity.id))
    .limit(1);
  const recent = run.startUtc.getTime() >= now.getTime() - COACH_CHANGE_RUN_DAYS * DAY_MS;
  if (newest?.id !== run.id || !recent) return { ok: false, reason: "stale_run", runFound: true };
  if (await openPause(executor, userId)) return { ok: false, reason: "paused", runFound: true };
  const active = await activePlan(executor, userId);
  if (!active || run.date < active.startDate) {
    return { ok: false, reason: "no_session", runFound: true };
  }
  const session = await nextSessionAfter(executor, {
    userId,
    activePlanId: active.id,
    runDate: run.date,
    today,
    lock,
  });
  if (!session) return { ok: false, reason: "no_session", runFound: true };
  return {
    ok: true,
    session,
    context: await deltaContext(executor, { userId, active, session, today }),
  };
}

export interface CoachChangeTarget {
  /** The prompt may offer a change: the plan's "change allowed" line. */
  allowed: boolean;
  reason: DeltaRejection | null;
  /** The session a change would be for, when there is one. */
  sessionId: string | null;
}

/**
 * Before the Claude call: whether the coach may change the plan after this run, and which session. Beyond
 * the run and pause rules (resolveTarget) it asks the engine about a rest, which is never clamped, so it
 * fails only for what no change may touch: a custom workout, a race, a locked session, or one the coach
 * already changed. The answer can go stale during the call; applyCoachChange decides again.
 */
export async function coachChangeTarget(
  userId: string,
  activityId: string,
  now = new Date(),
): Promise<CoachChangeTarget> {
  const target = await resolveTarget(db, { userId, activityId, now, lock: false });
  if (!target.ok) return { allowed: false, reason: target.reason, sessionId: null };
  const check = validateDelta(target.context, { kind: "rest" });
  return check.ok
    ? { allowed: true, reason: null, sessionId: target.session.id }
    : { allowed: false, reason: check.reason, sessionId: target.session.id };
}

export interface ApplyCoachChangeInput {
  userId: string;
  /** The reviewed run. */
  activityId: string;
  /** The insight that proposed the change, stored in the same transaction. */
  coachMessageId: string;
  /** The session the prompt saw (coachChangeTarget before the call); null when it saw none. */
  sessionId: string | null;
  delta: PlanDelta;
  /** The change's own next step for the card; a change without it is invalid. */
  nextStep: string | null;
  now: Date;
}

export interface CoachChangeResult {
  outcome: AdjustmentOutcome;
  reason: DeltaRejection | null;
  /** The change as applied, for the card; null when rejected. */
  planChange: PlanChange | null;
  /** A session changed in this call: queue a workout push after the commit. */
  changed: boolean;
}

function toPlanChange(
  row: Pick<PlanAdjustmentRow, "planSessionId" | "kind" | "outcome" | "before" | "after">,
  date: string,
): PlanChange {
  if (row.planSessionId === null || row.before === null || row.after === null) {
    throw new Error("An applied coach change has no session, before or after");
  }
  return {
    sessionId: row.planSessionId,
    date,
    kind: row.kind,
    clamped: row.outcome === "clamped",
    before: snapshotOf(row.before),
    after: snapshotOf(row.after),
  };
}

/** The run's stored proposal, as a second call for it answers. */
async function storedCoachChange(
  tx: DbTransaction,
  activityId: string,
): Promise<CoachChangeResult> {
  const [row] = await tx
    .select({ adjustment: planAdjustment, date: planSession.date })
    .from(planAdjustment)
    .leftJoin(planSession, eq(planSession.id, planAdjustment.planSessionId))
    .where(and(eq(planAdjustment.activityId, activityId), eq(planAdjustment.source, "coach")));
  if (!row) throw new Error("The coach change conflicted with a row that is not there");
  const { adjustment, date } = row;
  return {
    outcome: adjustment.outcome,
    reason: adjustment.reason,
    planChange:
      adjustment.outcome === "rejected" || date === null ? null : toPlanChange(adjustment, date),
    changed: false,
  };
}

function factorOf(delta: PlanDelta): number | null {
  return delta.kind === "scale" ? delta.factor : null;
}

/**
 * The engine's answer for the recomputed target. A target other than the session the prompt saw (skipped
 * or moved during the Claude call, or none seen) is no_session: the proposal was written for that one. A
 * change without its own next step is invalid, unless the engine rejects any change to the session first
 * (a rest asks, as coachChangeTarget does), since the card could not say what changed.
 */
function decide(target: Target, input: ApplyCoachChangeInput): DeltaResult {
  if (!target.ok) return { ok: false, reason: target.reason };
  if (target.session.id !== input.sessionId) return { ok: false, reason: "no_session" };
  if (input.nextStep === null) {
    const check = validateDelta(target.context, { kind: "rest" });
    return check.ok ? { ok: false, reason: "invalid" } : check;
  }
  return validateDelta(target.context, input.delta);
}

/**
 * Inside the caller's transaction, after the Claude call: decides the target again (the plan may have
 * changed meanwhile), its session locked FOR UPDATE, rejects the proposal when that is not the session the
 * prompt saw or it has no next step of its own (decide), else lets validateDelta accept, clamp or reject
 * it, and logs it (source coach) ON CONFLICT DO NOTHING on the one-per-run index: a second call for the
 * run changes nothing and answers the stored outcome. An accepted change is written to the session. A run
 * deleted meanwhile is rejected as stale with nothing logged, since the log row would point at it.
 */
export async function applyCoachChange(
  tx: DbTransaction,
  input: ApplyCoachChangeInput,
): Promise<CoachChangeResult> {
  const { userId, activityId, coachMessageId, sessionId, delta, now } = input;
  const target = await resolveTarget(tx, { userId, activityId, now, lock: true });
  if (!target.ok && !target.runFound) {
    return { outcome: "rejected", reason: "stale_run", planChange: null, changed: false };
  }
  const result = decide(target, input);
  // A target the prompt did not see is no session of this proposal's: logged without one.
  const session = target.ok && target.session.id === sessionId ? target.session : null;
  const outcome: AdjustmentOutcome = !result.ok
    ? "rejected"
    : result.clamped
      ? "clamped"
      : "applied";
  const before = session ? adjustedOf(session) : null;
  const inserted = await tx
    .insert(planAdjustment)
    .values({
      userId,
      planSessionId: session?.id ?? null,
      source: "coach",
      kind: delta.kind,
      outcome,
      reason: result.ok ? null : result.reason,
      requested: delta,
      applied: result.ok ? result.delta : null,
      before,
      after: result.ok ? result.session : null,
      activityId,
      coachMessageId,
    })
    .onConflictDoNothing({
      target: planAdjustment.activityId,
      where: sql`${planAdjustment.source} = 'coach'`,
    })
    .returning({ id: planAdjustment.id });
  if (inserted.length === 0) return storedCoachChange(tx, activityId);

  log.info(
    {
      userId,
      activityId,
      sessionId: session?.id ?? null,
      kind: delta.kind,
      requestedFactor: factorOf(delta),
      appliedFactor: result.ok ? factorOf(result.delta) : null,
      outcome,
      reason: result.ok ? null : result.reason,
    },
    `coach plan change ${outcome}`,
  );
  if (!result.ok || session === null) {
    return { outcome, reason: result.ok ? null : result.reason, planChange: null, changed: false };
  }
  const { type, title, status, steps, target: sessionTarget } = result.session;
  const updated = await tx
    .update(planSession)
    .set({ type, title, status, steps, target: sessionTarget })
    .where(and(eq(planSession.id, session.id), eq(planSession.status, session.status)))
    .returning({ id: planSession.id });
  // The row is locked since resolveTarget read it, so nothing can have changed it.
  if (updated.length === 0) throw new Error(`Session ${session.id} changed under its lock`);
  return {
    outcome,
    reason: null,
    planChange: toPlanChange(
      { planSessionId: session.id, kind: delta.kind, outcome, before, after: result.session },
      session.date,
    ),
    changed: true,
  };
}

/**
 * The plan change each coach card made, by coach message id, for the cards' mapping: applied or clamped
 * coach rows only (a rejected proposal changed nothing, and its note is never shown), dated as the session
 * is now.
 */
export async function planChangesFor(
  coachMessageIds: readonly string[],
): Promise<Map<string, PlanChange>> {
  const changes = new Map<string, PlanChange>();
  if (coachMessageIds.length === 0) return changes;
  const rows = await db
    .select({ adjustment: planAdjustment, date: planSession.date })
    .from(planAdjustment)
    .innerJoin(planSession, eq(planSession.id, planAdjustment.planSessionId))
    .where(
      and(
        inArray(planAdjustment.coachMessageId, [...coachMessageIds]),
        eq(planAdjustment.source, "coach"),
        inArray(planAdjustment.outcome, ACCEPTED),
      ),
    );
  for (const { adjustment, date } of rows) {
    changes.set(adjustment.coachMessageId!, toPlanChange(adjustment, date));
  }
  return changes;
}
