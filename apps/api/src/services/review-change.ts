import {
  type DeltaResult,
  validateWeekDeltas,
  type WeekDeltaContext,
  type WeekDeltaOutcome,
  type WeekDeltaProposal,
} from "@running-coach/engine";
import type { AdjustmentOutcome, PlanDelta, ReviewChangeProposal } from "@running-coach/shared";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../db/client";
import { planAdjustment, type PlanRow, planSession, type PlanSessionRow } from "../db/schema";
import { addDays, mondayOf } from "../lib/local-date";
import { logger } from "../lib/logger";
import {
  ACCEPTED,
  daysPerWeekOf,
  longestRecentRunM,
  planRaceOf,
  sessionHistories,
} from "./coach-change";
import { activePlan, type Executor, openPause, pauseCovering, runnerToday } from "./runner-state";
import { adjustedOf } from "./session-view";

// The weekly review's changes to the coming week (slice 10): the engine's validateWeekDeltas accepts,
// clamps or rejects each in date order against the week as the earlier ones left it, so the week's +10%
// cap holds over all of them. Every proposal is logged in plan_adjustment (source review), one row per
// session per review, so the review job retrying applies nothing twice.

const log = logger.child({ module: "review-change" });

/**
 * The sessions dated from..to of the plan (none when null) and the runner's custom workouts, any status,
 * by date, plan sessions before custom ones on a day, then id: the order the prompt labels the coming
 * week's s1..sN in and the card lists them in. `lock` takes them FOR UPDATE.
 */
export async function sessionsBetween(
  executor: Executor,
  {
    userId,
    planId,
    from,
    to,
    lock = false,
  }: { userId: string; planId: string | null; from: string; to: string; lock?: boolean },
): Promise<PlanSessionRow[]> {
  const query = executor
    .select()
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        planId === null
          ? isNull(planSession.planId)
          : or(eq(planSession.planId, planId), isNull(planSession.planId)),
        gte(planSession.date, from),
        lte(planSession.date, to),
      ),
    )
    .orderBy(asc(planSession.date), sql`${planSession.planId} is null`, asc(planSession.id));
  return lock ? await query.for("update") : await query;
}

/** The coming week of a review: the Monday after the reviewed week, to its Sunday. */
export function comingWeekOf(weekStart: string): { from: string; to: string } {
  return { from: addDays(weekStart, 7), to: addDays(weekStart, 13) };
}

export interface ReviewDeltaContext {
  context: WeekDeltaContext;
  /** The coming week's sessions, in label order. */
  sessions: PlanSessionRow[];
}

/**
 * What the engine reads to decide a review's changes, from the reads deltaContext makes for a run's: the
 * coming week's sessions with their phase (taper or race: no rise) and their earlier changes (by the coach
 * or a review, or eased by a re-entry); the plan's race (a long run near it: no rise); the reviewed week's
 * planned distance, skipped and missed sessions left out (none when the coming week is the plan's first,
 * which has no week before it); the longest measured run of 30 days; the goal's days a week; the open
 * pause; and whether a pause held a day of the reviewed week (afterPause: no rise).
 */
export async function reviewDeltaContext(
  executor: Executor,
  {
    userId,
    active,
    weekStart,
    today,
    lock = false,
  }: { userId: string; active: PlanRow; weekStart: string; today: string; lock?: boolean },
): Promise<ReviewDeltaContext> {
  const coming = comingWeekOf(weekStart);
  const sessions = await sessionsBetween(executor, {
    userId,
    planId: active.id,
    ...coming,
    lock,
  });
  const reviewed = await sessionsBetween(executor, {
    userId,
    planId: active.id,
    from: weekStart,
    to: addDays(weekStart, 6),
  });
  const previousWeekM =
    coming.from <= mondayOf(active.startDate)
      ? null
      : reviewed
          .filter((session) => session.status !== "skipped" && session.status !== "missed")
          .reduce((sum, session) => sum + session.target.distanceM, 0);
  const histories = await sessionHistories(
    executor,
    sessions.map((session) => session.id),
  );
  return {
    sessions,
    context: {
      today,
      sessions: sessions.map((session) => ({
        ...adjustedOf(session),
        id: session.id,
        date: session.date,
        source: session.planId === null ? "custom" : "plan",
        // Null for a custom workout (the row's check); a taper or race-week session may only shrink.
        phase: session.phase,
        coachAdjusted: histories.get(session.id)?.coachAdjusted ?? false,
        eased: histories.get(session.id)?.eased ?? false,
      })),
      race: planRaceOf(active),
      previousWeekM,
      longestRecentM: await longestRecentRunM(executor, userId, today),
      daysPerWeek: await daysPerWeekOf(executor, active),
      paces: active.paces,
      paused: (await openPause(executor, userId)) !== null,
      afterPause: (await pauseCovering(executor, userId, weekStart)) !== null,
    },
  };
}

/**
 * The review's proposal as the engine takes it. A scale without a usable factor stays a scale, with NaN,
 * so the engine rejects it as invalid and the log keeps the proposal.
 */
function deltaOf(proposal: ReviewChangeProposal): PlanDelta {
  switch (proposal.kind) {
    case "scale": {
      const { factor } = proposal;
      return {
        kind: "scale",
        factor: factor !== null && Number.isFinite(factor) ? factor : Number.NaN,
      };
    }
    case "easy":
      return { kind: "easy" };
    case "rest":
      return { kind: "rest" };
  }
}

export interface ApplyReviewChangesInput {
  userId: string;
  /** The weekly review that proposed them, stored in the same transaction. */
  coachMessageId: string;
  /** The reviewed week's Monday; the changes are for the week after it. */
  weekStart: string;
  /** The changes the coach proposed, in its order. */
  proposals: readonly ReviewChangeProposal[];
  /** The label the prompt gave each of the coming week's sessions, to its id. */
  labels: ReadonlyMap<string, string>;
  now: Date;
}

export interface ReviewChangesResult {
  /** The coach's note for each session the engine changed (applied or clamped), by session id. */
  notes: Record<string, string>;
  /** A session changed in this call: queue a workout push after the commit. */
  changed: boolean;
}

function factorOf(delta: PlanDelta): number | null {
  return delta.kind === "scale" ? delta.factor : null;
}

/**
 * The review's logged outcome, as a second call for it answers: the notes of the proposals whose session
 * the engine changed. Changes nothing.
 */
async function storedReviewChanges(
  tx: DbTransaction,
  input: ApplyReviewChangesInput,
): Promise<ReviewChangesResult> {
  const rows = await tx
    .select({ sessionId: planAdjustment.planSessionId })
    .from(planAdjustment)
    .where(
      and(
        eq(planAdjustment.coachMessageId, input.coachMessageId),
        eq(planAdjustment.source, "review"),
        inArray(planAdjustment.outcome, ACCEPTED),
      ),
    );
  const changed = new Set(rows.map((row) => row.sessionId));
  const notes: Record<string, string> = {};
  for (const proposal of input.proposals) {
    const sessionId = input.labels.get(proposal.session);
    if (sessionId !== undefined && changed.has(sessionId)) notes[sessionId] ??= proposal.note;
  }
  return { notes, changed: false };
}

/**
 * Inside the review's transaction, after the Claude call: when the review's proposals are logged already
 * (the job retrying), answers their stored outcome and changes nothing. Else it locks the coming week's
 * sessions FOR UPDATE, maps each proposal's label to the session the prompt showed under it (an unknown
 * label, or a session gone from the week since, is rejected no_session), lets validateWeekDeltas decide
 * them all against the week as it is now, logs one row per proposal (source review) ON CONFLICT DO NOTHING
 * on the one-per-session-per-review index (a second proposal for a session, rejected adjusted, is not
 * logged), and writes each accepted change to its session with an UPDATE guarded on the status it read.
 * Without an active plan every proposal is rejected no_session.
 */
export async function applyReviewChanges(
  tx: DbTransaction,
  input: ApplyReviewChangesInput,
): Promise<ReviewChangesResult> {
  const { userId, coachMessageId, weekStart, now } = input;
  const [logged] = await tx
    .select({ id: planAdjustment.id })
    .from(planAdjustment)
    .where(
      and(eq(planAdjustment.coachMessageId, coachMessageId), eq(planAdjustment.source, "review")),
    )
    .limit(1);
  if (logged) return storedReviewChanges(tx, input);

  const today = await runnerToday(tx, userId, now);
  const active = await activePlan(tx, userId);
  const decided = active
    ? await reviewDeltaContext(tx, { userId, active, weekStart, today, lock: true })
    : null;
  const proposals: WeekDeltaProposal[] = input.proposals.map((proposal) => ({
    sessionId: input.labels.get(proposal.session) ?? null,
    delta: deltaOf(proposal),
  }));
  const noSession: DeltaResult = { ok: false, reason: "no_session" };
  const outcomes: WeekDeltaOutcome[] = decided
    ? validateWeekDeltas(decided.context, proposals)
    : proposals.map(({ sessionId }) => ({ sessionId, result: noSession }));
  const byId = new Map(decided?.sessions.map((session) => [session.id, session]));

  const notes: Record<string, string> = {};
  let changed = false;
  for (const [index, { sessionId, result }] of outcomes.entries()) {
    const proposal = input.proposals[index]!;
    const { delta } = proposals[index]!;
    // A session gone from the coming week since the prompt showed it is logged without one.
    const session = sessionId === null ? null : (byId.get(sessionId) ?? null);
    const outcome: AdjustmentOutcome = !result.ok
      ? "rejected"
      : result.clamped
        ? "clamped"
        : "applied";
    const inserted = await tx
      .insert(planAdjustment)
      .values({
        userId,
        planSessionId: session?.id ?? null,
        source: "review",
        kind: delta.kind,
        outcome,
        reason: result.ok ? null : result.reason,
        requested: delta,
        applied: result.ok ? result.delta : null,
        before: session ? adjustedOf(session) : null,
        after: result.ok ? result.session : null,
        coachMessageId,
      })
      .onConflictDoNothing({
        target: [planAdjustment.coachMessageId, planAdjustment.planSessionId],
        where: sql`${planAdjustment.source} = 'review'`,
      })
      .returning({ id: planAdjustment.id });
    log.info(
      {
        userId,
        coachMessageId,
        label: proposal.session,
        sessionId: session?.id ?? null,
        kind: delta.kind,
        requestedFactor: factorOf(delta),
        appliedFactor: result.ok ? factorOf(result.delta) : null,
        outcome,
        reason: result.ok ? null : result.reason,
        logged: inserted.length > 0,
      },
      `review plan change ${outcome}`,
    );
    if (!result.ok || session === null || inserted.length === 0) continue;

    const { type, title, status, steps, target } = result.session;
    const updated = await tx
      .update(planSession)
      .set({ type, title, status, steps, target })
      .where(and(eq(planSession.id, session.id), eq(planSession.status, session.status)))
      .returning({ id: planSession.id });
    // The row is locked since reviewDeltaContext read it, so nothing can have changed it.
    if (updated.length === 0) throw new Error(`Session ${session.id} changed under its lock`);
    notes[session.id] = proposal.note;
    changed = true;
  }
  return { notes, changed };
}
