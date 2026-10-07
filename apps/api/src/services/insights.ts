import {
  type CoachAdjustment,
  type CoachCredentialChoice,
  type CoachFallbackReason,
  type CoachFeedback,
  ErrorCode,
  type InsightResponse,
  type PlanDelta,
  type RunInsight,
} from "@running-coach/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import type { CoachCallCredential } from "../coach/client";
import { runInsight } from "../coach/run-insight";
import type {
  InsightContext,
  InsightPlan,
  InsightSession,
} from "../coach/prompts/run-insight/input";
import { db } from "../db/client";
import {
  activity,
  type CoachMessage,
  coachMessage,
  plan,
  planSession,
  user,
  userSettings,
} from "../db/schema";
import {
  analyzeRunState,
  enqueueAnalyzeRun,
  pullAnalyzeRunForward,
} from "../jobs/analyze-run-queue";
import { decrypt } from "../lib/crypto";
import { DomainError } from "../lib/errors";
import { daysBetween, localDateOf } from "../lib/local-date";
import { logger } from "../lib/logger";
import {
  applyCoachChange,
  type CoachChangeResult,
  type CoachChangeTarget,
  coachChangeTarget,
  nextSessionAfter,
  planChangesFor,
} from "./coach-change";
import { coachCredentialOf, effectiveCoachCredential } from "./coach-credential";
import { runDate } from "./run-dates";
import { openPause } from "./runner-state";
import { queueWorkoutPush } from "./workout-push";

// The coach's card for a run: its state for the run screen, Ask the coach, thumbs, the analyze-run job's
// work and the queueing after a sync. Each follows the user's coach credential (coach-credential.ts): the
// Claude plan for the owner who chose it, else a saved key. The key is decrypted only in analyzeRun, for
// its one call on the key. Since run-insight v2 the coach may also propose a change to the next session,
// which the engine accepts, clamps or rejects (coach-change.ts) in the card's own transaction.

const log = logger.child({ module: "insights" });

/** A sync queues the coach for new runs that started within this many days of it; older ones wait for Ask. */
export const INSIGHT_WINDOW_DAYS = 7;
/** At most this many sessions of the run's day reach the prompt. */
const PLANNED_SESSIONS_MAX = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function runNotFound(): DomainError {
  return new DomainError(ErrorCode.notFound, 404, "That run does not exist.");
}

/** The user's run, or 404 when it is not theirs. */
async function ownRun(userId: string, activityId: string): Promise<void> {
  const [row] = await db
    .select({ id: activity.id })
    .from(activity)
    .where(and(eq(activity.id, activityId), eq(activity.userId, userId)));
  if (!row) throw runNotFound();
}

/** The run's one insight card, the model's or a fallback (one per run: coach_message's unique index). */
async function readCard(activityId: string): Promise<CoachMessage | undefined> {
  const [row] = await db
    .select()
    .from(coachMessage)
    .where(and(eq(coachMessage.activityId, activityId), eq(coachMessage.kind, "insight")));
  return row;
}

/** The stored card as the run screen reads it, with the plan change it made as the engine applied it. */
async function ready(card: CoachMessage): Promise<InsightResponse> {
  const changes = await planChangesFor([card.id]);
  return {
    state: "ready",
    insight: {
      id: card.id,
      // Parsed with runInsightSchema before it was stored, the fallback card built in its shape.
      content: card.content as RunInsight,
      fallbackReason: card.fallbackReason,
      feedback: card.feedback,
      planChange: changes.get(card.id) ?? null,
      createdAt: card.createdAt.toISOString(),
    },
  };
}

/**
 * GET /api/activities/:id/insight. The coach's card wins; else a live job means the coach is writing one
 * (retrying once it has failed, or with resumesAt while it waits for the plan's limit to reset), which
 * also covers Try again on a fallback card; else the fallback card; else none, or no_key when the coach
 * has no credential.
 */
export async function getInsight(userId: string, activityId: string): Promise<InsightResponse> {
  await ownRun(userId, activityId);
  // The job's state before the card: a job that stores its card and completes between the two reads is
  // then seen by the card read. The other way round it is seen by neither, and the answer is none.
  const live = await analyzeRunState(activityId);
  const card = await readCard(activityId);
  if (card && card.model !== null) return await ready(card);
  if (live) return live;
  if (card) return await ready(card);
  return { state: (await coachCredentialOf(userId)) === "none" ? "no_key" : "none" };
}

/**
 * POST /api/activities/:id/insight: Ask the coach, or Try again on a fallback card. Queues the job unless
 * the coach's card exists; a tap while a job waits folds into it (stately queue). Two exceptions:
 * a job held back to the plan's reset is pulled forward to now, so switching to a key, or a limit that
 * reset early, does not wait out the reset (up to days); a job retrying after a failure is left to its
 * backoff, since stately keeps one job per state and a send would queue a second beside it. 409 without
 * a credential: no key and not on the plan.
 */
export async function askCoach(userId: string, activityId: string): Promise<InsightResponse> {
  await ownRun(userId, activityId);
  const card = await readCard(activityId);
  if (card && card.model !== null) return await ready(card);
  if ((await coachCredentialOf(userId)) === "none") {
    throw new DomainError(
      ErrorCode.claudeKeyMissing,
      409,
      "Add your Claude key in Settings to get a coach review.",
    );
  }
  const live = await analyzeRunState(activityId);
  if (live?.state !== "retrying") {
    await enqueueAnalyzeRun({ userId, activityId });
  } else if (live.resumesAt === undefined) {
    return live;
  } else {
    await pullAnalyzeRunForward({ userId, activityId });
    log.info(
      { userId, activityId, resumesAt: live.resumesAt },
      "held-back run insight pulled forward",
    );
  }
  return (await analyzeRunState(activityId)) ?? { state: "pending" };
}

/** PUT /api/insights/:id/feedback: thumbs up, down, or null to clear, on the user's own card. */
export async function setInsightFeedback(
  userId: string,
  insightId: string,
  feedback: CoachFeedback | null,
): Promise<InsightResponse> {
  const [card] = await db
    .update(coachMessage)
    .set({ feedback })
    .where(
      and(
        eq(coachMessage.id, insightId),
        eq(coachMessage.userId, userId),
        eq(coachMessage.kind, "insight"),
      ),
    )
    .returning();
  if (!card) throw new DomainError(ErrorCode.notFound, 404, "That coach review does not exist.");
  return await ready(card);
}

function toInsightSession(row: {
  date: string;
  type: InsightSession["type"];
  title: string | null;
  target: { distanceM: number; durationS: number };
}): InsightSession {
  return {
    date: row.date,
    type: row.type,
    title: row.title,
    distanceM: row.target.distanceM,
    durationS: row.target.durationS,
  };
}

/**
 * The sessions of the run's local date and the next one, from the active plan and the runner's custom
 * workouts (the calendar's sources), plan sessions first on a day. Null without an active plan, and for
 * a run from before the active plan started, which the plan says nothing about. The next session is the
 * one the coach's change is for (nextSessionAfter in coach-change.ts): after the run's date, not before
 * the user's today, planned or moved. Run matching marks a past session without a run missed; the bound
 * on today also covers one it has not marked yet, before the next sync.
 */
async function insightPlan(
  userId: string,
  date: string,
  today: string,
): Promise<InsightPlan | null> {
  const [active] = await db
    .select({ id: plan.id, startDate: plan.startDate })
    .from(plan)
    .where(and(eq(plan.userId, userId), eq(plan.status, "active")));
  if (!active || date < active.startDate) return null;

  const columns = {
    date: planSession.date,
    type: planSession.type,
    title: planSession.title,
    target: planSession.target,
  };
  const sources = and(
    eq(planSession.userId, userId),
    or(eq(planSession.planId, active.id), isNull(planSession.planId)),
  );
  const order = [asc(planSession.date), sql`${planSession.planId} is null`, asc(planSession.id)];
  const planned = await db
    .select(columns)
    .from(planSession)
    .where(and(sources, eq(planSession.date, date), ne(planSession.status, "skipped")))
    .orderBy(...order)
    .limit(PLANNED_SESSIONS_MAX);
  const next = await nextSessionAfter(db, {
    userId,
    activePlanId: active.id,
    runDate: date,
    today,
  });
  return { planned: planned.map(toInsightSession), next: next ? toInsightSession(next) : null };
}

/**
 * What the coach knows beyond the run and the plan: the local days since the runner's previous run (by
 * UTC start, either way of a zone change), the open pause, and whether the plan may change.
 */
async function insightContext(
  userId: string,
  run: { id: string; startUtc: Date; startLocal: string },
  target: CoachChangeTarget,
): Promise<InsightContext> {
  const [previous] = await db
    .select({ date: runDate })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        ne(activity.id, run.id),
        lt(activity.startUtc, run.startUtc),
      ),
    )
    .orderBy(desc(activity.startUtc), desc(activity.id))
    .limit(1);
  const pause = await openPause(db, userId);
  const runDay = run.startLocal.slice(0, "YYYY-MM-DD".length);
  return {
    // A previous run in a zone ahead can carry a later local date: the same day, never negative.
    previousRunDays: previous ? Math.max(0, daysBetween(previous.date, runDay)) : null,
    pause: pause ? { reason: pause.reason, startDate: pause.startedOn } : null,
    planChange: { allowed: target.allowed, reason: target.reason },
  };
}

/**
 * The coach's proposal as the engine takes it; null for none. A scale without a usable factor stays a
 * scale, with NaN, so the engine rejects it as invalid and the log keeps the proposal.
 */
function deltaOf(adjustment: CoachAdjustment): PlanDelta | null {
  switch (adjustment.kind) {
    case "none":
      return null;
    case "scale": {
      const { factor } = adjustment;
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

/**
 * What runs the user's coach for one call: the Claude plan, or the saved key decrypted for this call only;
 * null when neither applies.
 */
function callCredential(
  userId: string,
  settings: {
    email: string;
    coachCredential: CoachCredentialChoice;
    claudeKeyEnc: string | null;
  },
): CoachCallCredential | null {
  const { claudeKeyEnc } = settings;
  const credential = effectiveCoachCredential({
    email: settings.email,
    choice: settings.coachCredential,
    hasClaudeKey: claudeKeyEnc !== null,
  });
  if (credential === "plan") return { kind: "plan" };
  if (credential === "key" && claudeKeyEnc !== null) {
    return { kind: "key", apiKey: decrypt(claudeKeyEnc, userId) };
  }
  return null;
}

export type AnalyzeRunOutcome =
  | { status: "stored"; coachMessageId: string; fallbackReason: CoachFallbackReason | null }
  /**
   * run_missing: deleted since it was queued. has_card: the coach's card exists. no_key: no credential any
   * more (the key removed, the plan no longer offered).
   */
  | { status: "skipped"; reason: "run_missing" | "has_card" | "no_key" };

export interface AnalyzeRunOptions {
  /** The job's last try: a timeout or Claude down then stores the fallback card instead of throwing. */
  lastAttempt: boolean;
  /** The clock the user's today is read from, for the next planned session and its change; tests pin it. */
  now?: Date;
}

// Claude did not answer: worth another try later. Any other fallback reason, request_rejected (no credit
// left) and plan_auth_failed (a rejected plan token) included, gives the same answer again.
const RETRYABLE_REASONS: ReadonlySet<CoachFallbackReason> = new Set(["timeout", "unavailable"]);

function isForeignKeyViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return (cause?.code ?? (error as { code?: unknown }).code) === "23503";
}

/**
 * The analyze-run job's work: writes the coach's card for one run and stores it, replacing a fallback
 * card but never the coach's own, so a double fire makes no second call, never two cards and never a
 * second plan change. The plan lines come from the run's own local date (start_local), never its UTC
 * date. Whether the coach may change the next session is asked before the call (coachChangeTarget). The
 * card and the change its output proposes are stored in one transaction: applyCoachChange decides again,
 * for the session the prompt saw only, logs the proposal and writes an accepted one to the session, and
 * the card's nextStep is the change's own when the engine applied or clamped it, else the plain one (a
 * rejected change drops its text; a change without text is rejected as invalid). A change queues a
 * workout push after the commit. A timeout or Claude down before the last attempt stores nothing and
 * throws claude_unavailable, so pg-boss retries with backoff; the plan's usage limit stores nothing and
 * throws claude_plan_limited with the seconds to its reset on any attempt, for the job to defer itself; a
 * refusal, max_tokens, invalid output, a rejected key or plan token, or a request Claude turned down
 * store the fallback card at once, which never changes the plan.
 */
export async function analyzeRun(
  userId: string,
  activityId: string,
  { lastAttempt, now = new Date() }: AnalyzeRunOptions,
): Promise<AnalyzeRunOutcome> {
  const [run] = await db
    .select()
    .from(activity)
    .where(and(eq(activity.id, activityId), eq(activity.userId, userId)));
  if (!run) return { status: "skipped", reason: "run_missing" };
  if ((await readCard(activityId))?.model) return { status: "skipped", reason: "has_card" };

  const [settings] = await db
    .select({
      email: user.email,
      units: userSettings.units,
      timezone: userSettings.timezone,
      coachDetail: userSettings.coachDetail,
      claudeKeyEnc: userSettings.claudeKeyEnc,
      coachCredential: userSettings.coachCredential,
    })
    .from(userSettings)
    .innerJoin(user, eq(user.id, userSettings.userId))
    .where(eq(userSettings.userId, userId));
  const credential = settings ? callCredential(userId, settings) : null;
  if (!settings || !credential) return { status: "skipped", reason: "no_key" };

  const target = await coachChangeTarget(userId, activityId, now);
  const result = await runInsight({
    credential,
    activity: run,
    settings: { units: settings.units, coachDetail: settings.coachDetail },
    plan: await insightPlan(
      userId,
      run.startLocal.slice(0, "YYYY-MM-DD".length),
      localDateOf(now, settings.timezone),
    ),
    context: await insightContext(userId, run, target),
  });
  if (result.limited) {
    log.warn(
      {
        userId,
        activityId,
        credential: credential.kind,
        claudeRequestId: result.requestId,
        retryAfterSeconds: result.retryAfterSeconds,
      },
      "coach plan usage limit reached; the job waits for the reset",
    );
    throw new DomainError(
      ErrorCode.claudePlanLimited,
      429,
      "The Claude plan's usage limit is reached. The coach tries again when it resets.",
      { retryAfterSeconds: result.retryAfterSeconds },
    );
  }
  const context = {
    userId,
    activityId,
    credential: credential.kind,
    claudeRequestId: result.requestId,
    model: result.model,
    fallbackReason: result.fallbackReason,
    usage: result.usage,
  };
  if (result.fallbackReason && RETRYABLE_REASONS.has(result.fallbackReason) && !lastAttempt) {
    log.warn(context, "coach did not answer; the job tries again later");
    throw new DomainError(
      ErrorCode.claudeUnavailable,
      502,
      "Claude did not answer. The coach tries again later.",
    );
  }

  const card = {
    promptVersion: result.promptVersion,
    model: result.model,
    content: result.content,
    usage: result.usage,
    fallbackReason: result.fallbackReason,
  };
  const delta = result.adjustment ? deltaOf(result.adjustment) : null;
  const changedStep = result.adjustment?.nextStep ?? null;
  let stored: { id: string; change: CoachChangeResult | null } | null;
  try {
    stored = await db.transaction(async (tx) => {
      const [message] = await tx
        .insert(coachMessage)
        .values({ userId, kind: "insight", activityId, ...card })
        .onConflictDoUpdate({
          target: coachMessage.activityId,
          targetWhere: sql`${coachMessage.kind} = 'insight'`,
          // A new card: new thumbs, new date.
          set: { ...card, feedback: null, createdAt: sql`now()`, updatedAt: sql`now()` },
          // Only over a fallback card: the coach's card stays whatever finished second.
          setWhere: sql`${sql.identifier("coach_message")}.${sql.identifier("model")} is null`,
        })
        .returning({ id: coachMessage.id });
      if (!message) return null;
      if (!delta) return { id: message.id, change: null };
      const change = await applyCoachChange(tx, {
        userId,
        activityId,
        coachMessageId: message.id,
        // The session the prompt named: a change lands on that one or on none.
        sessionId: target.sessionId,
        delta,
        nextStep: changedStep,
        now,
      });
      if (change.outcome !== "rejected" && changedStep !== null) {
        await tx
          .update(coachMessage)
          .set({ content: { ...result.content, nextStep: changedStep } })
          .where(eq(coachMessage.id, message.id));
      }
      return { id: message.id, change };
    });
  } catch (error) {
    // The run was deleted (a Garmin delete synced) while Claude wrote: nothing to attach the card to.
    if (isForeignKeyViolation(error)) return { status: "skipped", reason: "run_missing" };
    throw error;
  }
  if (!stored) {
    log.info(context, "coach card kept; another job stored it first");
    return { status: "skipped", reason: "has_card" };
  }
  const { id: coachMessageId, change } = stored;
  log.info(
    { ...context, coachMessageId, planChange: change?.outcome ?? null },
    "run insight stored",
  );
  if (change?.changed) {
    try {
      await queueWorkoutPush(userId);
    } catch (err) {
      // The change is stored: the daily push sends it, so the card does not fail over the queue.
      log.error(
        { err, userId, activityId, coachMessageId },
        "workout push not queued after a coach change",
      );
    }
  }
  return { status: "stored", coachMessageId, fallbackReason: result.fallbackReason };
}

/**
 * Queues the coach for the runs a sync just inserted that started within INSIGHT_WINDOW_DAYS of `now` and
 * have no card, only when the coach has a credential (a key, or the owner's plan): an older run, an
 * import's or one Garmin edited gets none (Ask the coach covers it). Never throws, so a sync never fails
 * over it; returns how many it queued.
 */
export async function queueRunInsights(
  userId: string,
  activityIds: readonly string[],
  now: Date,
): Promise<number> {
  if (activityIds.length === 0) return 0;
  try {
    if ((await coachCredentialOf(userId)) === "none") return 0;
    const runs = await db
      .select({ id: activity.id })
      .from(activity)
      .where(
        and(
          eq(activity.userId, userId),
          inArray(activity.id, [...activityIds]),
          gte(activity.startUtc, new Date(now.getTime() - INSIGHT_WINDOW_DAYS * DAY_MS)),
          notExists(
            db
              .select({ id: coachMessage.id })
              .from(coachMessage)
              .where(
                and(eq(coachMessage.activityId, activity.id), eq(coachMessage.kind, "insight")),
              ),
          ),
        ),
      );
    let queued = 0;
    for (const run of runs) {
      if ((await enqueueAnalyzeRun({ userId, activityId: run.id })) !== null) queued += 1;
    }
    if (runs.length > 0) log.info({ userId, runs: runs.length, queued }, "run insights queued");
    return queued;
  } catch (err) {
    log.error({ err, userId }, "run insights not queued; Ask the coach on a run queues one");
    return 0;
  }
}
