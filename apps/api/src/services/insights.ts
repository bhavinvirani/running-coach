import {
  type CoachFallbackReason,
  type CoachFeedback,
  ErrorCode,
  type InsightResponse,
  type RunInsight,
} from "@running-coach/shared";
import { and, asc, eq, gt, gte, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { runInsight } from "../coach/run-insight";
import type { InsightPlan, InsightSession } from "../coach/prompts/run-insight/input";
import { db } from "../db/client";
import {
  activity,
  type CoachMessage,
  coachMessage,
  plan,
  planSession,
  userSettings,
} from "../db/schema";
import { analyzeRunState, enqueueAnalyzeRun } from "../jobs/analyze-run-queue";
import { decrypt } from "../lib/crypto";
import { DomainError } from "../lib/errors";
import { logger } from "../lib/logger";

// The coach's card for a run: its state for the run screen, Ask the coach, thumbs, the analyze-run job's
// work and the queueing after a sync. The key is decrypted only in analyzeRun, for its one call.

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

async function hasClaudeKey(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ claudeKeyEnc: userSettings.claudeKeyEnc })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return (row?.claudeKeyEnc ?? null) !== null;
}

function ready(card: CoachMessage): InsightResponse {
  return {
    state: "ready",
    insight: {
      id: card.id,
      // Parsed with runInsightSchema before it was stored, the fallback card built in its shape.
      content: card.content as RunInsight,
      fallbackReason: card.fallbackReason,
      feedback: card.feedback,
      createdAt: card.createdAt.toISOString(),
    },
  };
}

/**
 * GET /api/activities/:id/insight. The coach's card wins; else a live job means the coach is writing one
 * (retrying once it has failed), which also covers Try again on a fallback card; else the fallback card;
 * else no_key or none.
 */
export async function getInsight(userId: string, activityId: string): Promise<InsightResponse> {
  await ownRun(userId, activityId);
  const card = await readCard(activityId);
  if (card && card.model !== null) return ready(card);
  const live = await analyzeRunState(activityId);
  if (live) return { state: live };
  if (card) return ready(card);
  return { state: (await hasClaudeKey(userId)) ? "none" : "no_key" };
}

/**
 * POST /api/activities/:id/insight: Ask the coach, or Try again on a fallback card. Queues the job unless
 * the coach's card exists; a tap while a job waits folds into it (stately queue). 409 without a key.
 */
export async function askCoach(userId: string, activityId: string): Promise<InsightResponse> {
  await ownRun(userId, activityId);
  const card = await readCard(activityId);
  if (card && card.model !== null) return ready(card);
  if (!(await hasClaudeKey(userId))) {
    throw new DomainError(
      ErrorCode.claudeKeyMissing,
      409,
      "Add your Claude key in Settings to get a coach review.",
    );
  }
  await enqueueAnalyzeRun({ userId, activityId });
  return { state: (await analyzeRunState(activityId)) ?? "pending" };
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
  return ready(card);
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
 * workouts (the calendar's sources), plan sessions first on a day. Null without an active plan.
 */
async function insightPlan(userId: string, date: string): Promise<InsightPlan | null> {
  const [active] = await db
    .select({ id: plan.id })
    .from(plan)
    .where(and(eq(plan.userId, userId), eq(plan.status, "active")));
  if (!active) return null;

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
  const [next] = await db
    .select(columns)
    .from(planSession)
    .where(
      and(sources, gt(planSession.date, date), inArray(planSession.status, ["planned", "moved"])),
    )
    .orderBy(...order)
    .limit(1);
  return { planned: planned.map(toInsightSession), next: next ? toInsightSession(next) : null };
}

export type AnalyzeRunOutcome =
  | { status: "stored"; coachMessageId: string; fallbackReason: CoachFallbackReason | null }
  /** run_missing: deleted since it was queued. has_card: the coach's card exists. no_key: removed since. */
  | { status: "skipped"; reason: "run_missing" | "has_card" | "no_key" };

export interface AnalyzeRunOptions {
  /** The job's last try: a timeout or Claude down then stores the fallback card instead of throwing. */
  lastAttempt: boolean;
}

// Claude did not answer: worth another try later. Any other fallback reason gives the same answer again.
const RETRYABLE_REASONS: ReadonlySet<CoachFallbackReason> = new Set(["timeout", "unavailable"]);

function isForeignKeyViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return (cause?.code ?? (error as { code?: unknown }).code) === "23503";
}

/**
 * The analyze-run job's work: writes the coach's card for one run and stores it, replacing a fallback
 * card but never the coach's own, so a double fire makes no second call and never two cards. The plan
 * lines come from the run's own local date (start_local), never its UTC date. A timeout or Claude down
 * before the last attempt stores nothing and throws claude_unavailable, so pg-boss retries with backoff;
 * a refusal, max_tokens, invalid output or a rejected key store the fallback card at once.
 */
export async function analyzeRun(
  userId: string,
  activityId: string,
  { lastAttempt }: AnalyzeRunOptions,
): Promise<AnalyzeRunOutcome> {
  const [run] = await db
    .select()
    .from(activity)
    .where(and(eq(activity.id, activityId), eq(activity.userId, userId)));
  if (!run) return { status: "skipped", reason: "run_missing" };
  if ((await readCard(activityId))?.model) return { status: "skipped", reason: "has_card" };

  const [settings] = await db
    .select({
      units: userSettings.units,
      coachDetail: userSettings.coachDetail,
      claudeKeyEnc: userSettings.claudeKeyEnc,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  if (!settings?.claudeKeyEnc) return { status: "skipped", reason: "no_key" };

  const result = await runInsight({
    apiKey: decrypt(settings.claudeKeyEnc, userId),
    activity: run,
    settings: { units: settings.units, coachDetail: settings.coachDetail },
    plan: await insightPlan(userId, run.startLocal.slice(0, "YYYY-MM-DD".length)),
  });
  const context = {
    userId,
    activityId,
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
  let stored: { id: string }[];
  try {
    stored = await db
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
  } catch (error) {
    // The run was deleted (a Garmin delete synced) while Claude wrote: nothing to attach the card to.
    if (isForeignKeyViolation(error)) return { status: "skipped", reason: "run_missing" };
    throw error;
  }
  const [message] = stored;
  if (!message) {
    log.info(context, "coach card kept; another job stored it first");
    return { status: "skipped", reason: "has_card" };
  }
  log.info({ ...context, coachMessageId: message.id }, "run insight stored");
  return { status: "stored", coachMessageId: message.id, fallbackReason: result.fallbackReason };
}

/**
 * Queues the coach for the runs a sync just inserted that started within INSIGHT_WINDOW_DAYS of `now` and
 * have no card, only when the user has a Claude key: an older run, an import's or one Garmin edited gets
 * none (Ask the coach covers it). Never throws, so a sync never fails over it; returns how many it queued.
 */
export async function queueRunInsights(
  userId: string,
  activityIds: readonly string[],
  now: Date,
): Promise<number> {
  if (activityIds.length === 0) return 0;
  try {
    if (!(await hasClaudeKey(userId))) return 0;
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
