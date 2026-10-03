import {
  type CoachCredentialChoice,
  type CoachFallbackReason,
  type CoachFeedback,
  ErrorCode,
  type InsightResponse,
  type RunInsight,
} from "@running-coach/shared";
import { and, asc, eq, gt, gte, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { CoachCallCredential } from "../coach/client";
import { runInsight } from "../coach/run-insight";
import type { InsightPlan, InsightSession } from "../coach/prompts/run-insight/input";
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
import { analyzeRunState, enqueueAnalyzeRun } from "../jobs/analyze-run-queue";
import { decrypt } from "../lib/crypto";
import { DomainError } from "../lib/errors";
import { localDateOf } from "../lib/local-date";
import { logger } from "../lib/logger";
import { coachCredentialOf, effectiveCoachCredential } from "./coach-credential";

// The coach's card for a run: its state for the run screen, Ask the coach, thumbs, the analyze-run job's
// work and the queueing after a sync. Each follows the user's coach credential (coach-credential.ts): the
// Claude plan for the owner who chose it, else a saved key. The key is decrypted only in analyzeRun, for
// its one call on the key.

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
 * (retrying once it has failed or waits for the plan's limit to reset), which also covers Try again on
 * a fallback card; else the fallback card; else none, or no_key when the coach has no credential.
 */
export async function getInsight(userId: string, activityId: string): Promise<InsightResponse> {
  await ownRun(userId, activityId);
  // The job's state before the card: a job that stores its card and completes between the two reads is
  // then seen by the card read. The other way round it is seen by neither, and the answer is none.
  const live = await analyzeRunState(activityId);
  const card = await readCard(activityId);
  if (card && card.model !== null) return ready(card);
  if (live) return { state: live };
  if (card) return ready(card);
  return { state: (await coachCredentialOf(userId)) === "none" ? "no_key" : "none" };
}

/**
 * POST /api/activities/:id/insight: Ask the coach, or Try again on a fallback card. Queues the job unless
 * the coach's card exists; a tap while a job waits folds into it (stately queue), a job deferred to the
 * plan's reset included. 409 without a credential: no key and not on the plan.
 */
export async function askCoach(userId: string, activityId: string): Promise<InsightResponse> {
  await ownRun(userId, activityId);
  const card = await readCard(activityId);
  if (card && card.model !== null) return ready(card);
  if ((await coachCredentialOf(userId)) === "none") {
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
 * workouts (the calendar's sources), plan sessions first on a day. Null without an active plan, and for
 * a run from before the active plan started, which the plan says nothing about. The next session is
 * after the run's date and not before the user's today: nothing marks a session missed until slice 9,
 * so a past session still reads planned.
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
  const [next] = await db
    .select(columns)
    .from(planSession)
    .where(
      and(
        sources,
        gt(planSession.date, date),
        gte(planSession.date, today),
        inArray(planSession.status, ["planned", "moved"]),
      ),
    )
    .orderBy(...order)
    .limit(1);
  return { planned: planned.map(toInsightSession), next: next ? toInsightSession(next) : null };
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
  /** The clock the user's today is read from, for the next planned session; tests pin it. */
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
 * card but never the coach's own, so a double fire makes no second call and never two cards. The plan
 * lines come from the run's own local date (start_local), never its UTC date. A timeout or Claude down
 * before the last attempt stores nothing and throws claude_unavailable, so pg-boss retries with backoff;
 * the plan's usage limit stores nothing and throws claude_plan_limited with the seconds to its reset on
 * any attempt, for the job to defer itself; a refusal, max_tokens, invalid output, a rejected key or plan
 * token, or a request Claude turned down store the fallback card at once.
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

  const result = await runInsight({
    credential,
    activity: run,
    settings: { units: settings.units, coachDetail: settings.coachDetail },
    plan: await insightPlan(
      userId,
      run.startLocal.slice(0, "YYYY-MM-DD".length),
      localDateOf(now, settings.timezone),
    ),
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
