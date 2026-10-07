import { validateWeekDeltas } from "@running-coach/engine";
import {
  type CoachFallbackReason,
  type CoachFeedback,
  type DeltaRejection,
  ErrorCode,
  type LatestReviewResponse,
  type PlanPhase,
  type ReviewChange,
  type ReviewListResponse,
  type ReviewResponse,
  type ReviewWeekSummary,
  type WeeklyReview,
  type WeeklyReviewCard,
} from "@running-coach/shared";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type {
  ReviewExtraRun,
  ReviewPlan,
  ReviewWeek,
  ReviewWeekSession,
} from "../coach/prompts/weekly-review/input";
import { weeklyReview } from "../coach/weekly-review";
import { db } from "../db/client";
import {
  activity,
  type CoachMessage,
  coachMessage,
  goal,
  planAdjustment,
  type PlanRow,
  planSession,
  user,
  userSettings,
} from "../db/schema";
import { enqueueWeeklyReview, weeklyReviewState } from "../jobs/weekly-review-queue";
import { DomainError } from "../lib/errors";
import { addDays, daysBetween, localDateOf, mondayOf } from "../lib/local-date";
import { logger } from "../lib/logger";
import { ACCEPTED, toPlanChange } from "./coach-change";
import { callCredential, coachCredentialOf } from "./coach-credential";
import { isForeignKeyViolation } from "./insights";
import {
  applyReviewChanges,
  comingWeekOf,
  reviewDeltaContext,
  sessionsBetween,
} from "./review-change";
import { runDate, runDateWithin } from "./run-dates";
import { activePlan, pauseCovering, runnerToday } from "./runner-state";
import { queueWorkoutPush } from "./workout-push";

// The coach's weekly review (slice 10): one per runner per Monday-to-Sunday week, written once the week
// has ended in the runner's zone. Every sync queues it (queueWeeklyReview), the weekly-review job writes
// it (writeWeeklyReview) with the changes the engine accepts for the coming week (review-change.ts), and
// the review routes read it. The key is decrypted only in writeWeeklyReview, for its one call.

const log = logger.child({ module: "weekly-review" });

/** The most past reviews the list returns: a year of weeks. */
export const REVIEW_LIST_MAX = 52;

/** What coach_message.content holds for a weekly review. */
export interface StoredWeeklyReview {
  /** The card as the model wrote it, or the fallback card (weeklyReviewSchema, parsed before it was stored). */
  card: WeeklyReview;
  /** The reviewed week in numbers as they stood when the review was written. */
  summary: ReviewWeekSummary;
  /** The coach's note for each session the engine changed (applied or clamped), by session id. */
  notes: Record<string, string>;
}

/**
 * The Monday of the last Monday-to-Sunday week that has ended on the runner's local date `today`: the
 * week before today's. Local dates only, so a DST change never moves it.
 */
export function lastEndedWeek(today: string): string {
  return addDays(mondayOf(today), -7);
}

function reviewNotFound(): DomainError {
  return new DomainError(ErrorCode.notFound, 404, "That weekly review does not exist.");
}

/** The runner's review of the week, the model's or a fallback card (one per week: coach_message's index). */
async function readReview(userId: string, weekStart: string): Promise<CoachMessage | undefined> {
  const [row] = await db
    .select()
    .from(coachMessage)
    .where(
      and(
        eq(coachMessage.userId, userId),
        eq(coachMessage.kind, "weekly_review"),
        eq(coachMessage.weekStart, weekStart),
      ),
    );
  return row;
}

/** Sessions of the active plan, or custom ones only without it. */
function sessionSources(active: PlanRow | null) {
  return active === null
    ? isNull(planSession.planId)
    : or(eq(planSession.planId, active.id), isNull(planSession.planId));
}

/** The week had something to review: a run on its dates, a session (any status) or a pause over a day. */
async function weekHadTraining(userId: string, weekStart: string): Promise<boolean> {
  const weekEnd = addDays(weekStart, 6);
  const [run] = await db
    .select({ id: activity.id })
    .from(activity)
    .where(and(eq(activity.userId, userId), runDateWithin(weekStart, weekEnd)))
    .limit(1);
  if (run) return true;
  const active = await activePlan(db, userId);
  const [session] = await db
    .select({ id: planSession.id })
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        sessionSources(active),
        gte(planSession.date, weekStart),
        lte(planSession.date, weekEnd),
      ),
    )
    .limit(1);
  if (session) return true;
  return (await pauseCovering(db, userId, weekStart)) !== null;
}

/**
 * Queues the review of the runner's last ended week (lastEndedWeek of their local date at `now`), run by
 * every sync, the failed ones too, so the daily cron's sync or the first open after the week ends covers
 * it. Skips when that week's review is stored, when the coach has no credential, and when the week had no
 * run, no session and no pause; else sends the job with the week's id, so a second sync, or the cron
 * firing twice, queues nothing. Never throws, so a sync never fails over it; returns whether it queued.
 */
export async function queueWeeklyReview(userId: string, now: Date): Promise<boolean> {
  try {
    const weekStart = lastEndedWeek(await runnerToday(db, userId, now));
    if (await readReview(userId, weekStart)) return false;
    if ((await coachCredentialOf(userId)) === "none") return false;
    if (!(await weekHadTraining(userId, weekStart))) return false;
    const id = await enqueueWeeklyReview({ userId, weekStart });
    if (id !== null) log.info({ userId, weekStart }, "weekly review queued");
    return id !== null;
  } catch (err) {
    log.error({ err, userId }, "weekly review not queued; the next sync queues it");
    return false;
  }
}

/**
 * The reviewed week as the prompt reads it: the active plan's and the runner's custom sessions dated in it,
 * any status, with the run each matched; the runs on its local dates no session matched; its totals; the
 * week before's runs; and the pause that held a day of it.
 */
async function readReviewWeek(
  userId: string,
  weekStart: string,
  active: PlanRow | null,
): Promise<ReviewWeek> {
  const weekEnd = addDays(weekStart, 6);
  const rows = await db
    .select({
      session: planSession,
      runId: activity.id,
      runDistanceM: activity.distanceM,
      runDurationS: activity.durationS,
      runAvgHr: activity.avgHr,
      runIsIndoor: activity.isIndoor,
    })
    .from(planSession)
    .leftJoin(activity, eq(activity.id, planSession.activityId))
    .where(
      and(
        eq(planSession.userId, userId),
        sessionSources(active),
        gte(planSession.date, weekStart),
        lte(planSession.date, weekEnd),
      ),
    )
    .orderBy(asc(planSession.date), sql`${planSession.planId} is null`, asc(planSession.id));
  const sessions: ReviewWeekSession[] = rows.map((row) => ({
    date: row.session.date,
    type: row.session.type,
    title: row.session.title,
    status: row.session.status,
    distanceM: row.session.target.distanceM,
    durationS: row.session.target.durationS,
    run:
      row.runId === null
        ? null
        : {
            distanceM: row.runDistanceM!,
            durationS: row.runDurationS!,
            avgHr: row.runAvgHr,
            isIndoor: row.runIsIndoor!,
          },
  }));
  const matched = new Set(rows.flatMap((row) => (row.runId === null ? [] : [row.runId])));

  const runColumns = {
    id: activity.id,
    date: runDate,
    distanceM: activity.distanceM,
    durationS: activity.durationS,
    avgHr: activity.avgHr,
    isIndoor: activity.isIndoor,
  };
  const runs = await db
    .select(runColumns)
    .from(activity)
    .where(and(eq(activity.userId, userId), runDateWithin(weekStart, weekEnd)))
    .orderBy(asc(activity.startLocal), asc(activity.id));
  const extraRuns: ReviewExtraRun[] = runs
    .filter((run) => !matched.has(run.id))
    .map(({ date, distanceM, durationS, avgHr, isIndoor }) => ({
      date,
      distanceM,
      durationS,
      avgHr,
      isIndoor,
    }));
  const before = await db
    .select({ distanceM: activity.distanceM })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        runDateWithin(addDays(weekStart, -7), addDays(weekStart, -1)),
      ),
    );

  const pause = await pauseCovering(db, userId, weekStart);
  const live = rows.filter((row) => row.session.status !== "skipped");
  const summary: ReviewWeekSummary = {
    runs: runs.length,
    distanceM: Math.round(runs.reduce((sum, run) => sum + run.distanceM, 0)),
    durationS: Math.round(runs.reduce((sum, run) => sum + run.durationS, 0)),
    sessionsPlanned: live.length,
    sessionsDone: live.filter((row) => row.session.status === "done").length,
    plannedDistanceM: Math.round(live.reduce((sum, row) => sum + row.session.target.distanceM, 0)),
    paused: pause !== null,
  };
  return {
    weekStart,
    sessions,
    extraRuns,
    summary,
    weekBefore:
      before.length === 0
        ? null
        : {
            runs: before.length,
            distanceM: Math.round(before.reduce((sum, run) => sum + run.distanceM, 0)),
          },
    pause: pause
      ? { reason: pause.reason, startDate: pause.startedOn, endDate: pause.endedOn }
      : null,
  };
}

/**
 * The phase of the plan's week from `monday`: its plan sessions' phase, else the latest week's before it,
 * else the first, as the plan screen's weeks take it (plan.ts); null for a plan without sessions.
 */
async function phaseOf(active: PlanRow, monday: string): Promise<PlanPhase | null> {
  const rows = await db
    .select({ date: planSession.date, phase: planSession.phase })
    .from(planSession)
    .where(and(eq(planSession.planId, active.id), isNotNull(planSession.phase)))
    .orderBy(asc(planSession.date), asc(planSession.id));
  const sunday = addDays(monday, 6);
  const phased = rows.flatMap(({ date, phase }) => (phase === null ? [] : [{ date, phase }]));
  return (
    phased.find(({ date }) => date >= monday && date <= sunday)?.phase ??
    phased.findLast(({ date }) => date < monday)?.phase ??
    phased[0]?.phase ??
    null
  );
}

interface ReviewPlanInput {
  plan: ReviewPlan | null;
  /** The label the prompt gives each of the coming week's sessions, to its id. */
  labels: Map<string, string>;
}

/**
 * The plan as the prompt reads it: the goal, the coming week's number, phase and weeks to the race, and its
 * sessions (the active plan's and custom ones, any status) labelled s1..sN in date order, plan sessions
 * before custom ones on a day, each changeable when the engine would take a rest for it, which is never
 * clamped, so it refuses only what no change may touch (a race, a custom workout, a locked session, one
 * the coach already changed) or the open pause. Null without an active plan, or when the coming week lies
 * outside it (a plan that starts later, or one that has ended): nothing then may change.
 */
async function readReviewPlan(
  userId: string,
  weekStart: string,
  today: string,
  active: PlanRow | null,
): Promise<ReviewPlanInput> {
  const none: ReviewPlanInput = { plan: null, labels: new Map() };
  const coming = comingWeekOf(weekStart);
  if (!active || coming.from < active.startDate || coming.from > active.endDate) return none;
  const phase = await phaseOf(active, coming.from);
  const [goalRow] = await db
    .select({
      kind: goal.kind,
      distanceKey: goal.distanceKey,
      raceDate: goal.raceDate,
      targetTimeS: goal.targetTimeS,
    })
    .from(goal)
    .where(eq(goal.id, active.goalId));
  if (phase === null || !goalRow) return none;

  const { context, sessions } = await reviewDeltaContext(db, { userId, active, weekStart, today });
  const labelled = sessions.map((session, index) => {
    const [check] = validateWeekDeltas(context, [
      { sessionId: session.id, delta: { kind: "rest" } },
    ]);
    return { label: `s${index + 1}`, session, verdict: check!.result };
  });
  const changeAllowed = labelled.some(({ verdict }) => verdict.ok);
  const refusals = labelled.flatMap(({ verdict }) => (verdict.ok ? [] : [verdict.reason]));
  const reason: DeltaRejection | null = changeAllowed
    ? null
    : context.paused
      ? "paused"
      : (refusals[0] ?? "no_session");
  return {
    labels: new Map(labelled.map(({ label, session }) => [label, session.id])),
    plan: {
      goal: goalRow,
      weekNumber: Math.floor(daysBetween(active.startDate, coming.from) / 7) + 1,
      phase,
      weeksToRace:
        goalRow.raceDate === null
          ? null
          : Math.max(0, Math.floor(daysBetween(coming.from, mondayOf(goalRow.raceDate)) / 7)),
      sessions: labelled.map(({ label, session, verdict }) => ({
        label,
        date: session.date,
        type: session.type,
        title: session.title,
        status: session.status,
        distanceM: session.target.distanceM,
        durationS: session.target.durationS,
        changeable: verdict.ok,
      })),
      changeAllowed,
      reason,
    },
  };
}

export type WriteWeeklyReviewOutcome =
  | {
      status: "stored";
      coachMessageId: string;
      fallbackReason: CoachFallbackReason | null;
      /** The engine changed a session of the coming week. */
      changed: boolean;
    }
  /**
   * has_review: the coach's review of the week is stored. no_key: no credential any more (the key
   * removed, the plan no longer offered). gone: the runner or the plan was deleted while the coach wrote.
   */
  | { status: "skipped"; reason: "has_review" | "no_key" | "gone" };

export interface WriteWeeklyReviewOptions {
  /** The job's last try: a timeout or Claude down then stores the fallback card instead of throwing. */
  lastAttempt: boolean;
  /** The clock the runner's today is read from, for which sessions are past; tests pin it. */
  now?: Date;
}

// Claude did not answer: worth another try later. Any other fallback reason gives the same answer again.
const RETRYABLE_REASONS: ReadonlySet<CoachFallbackReason> = new Set(["timeout", "unavailable"]);

/**
 * The weekly-review job's work, as analyzeRun is a run's: writes the coach's review of the week from
 * weekStart and stores it, replacing a fallback card but never the coach's own, so a double fire makes no
 * second call, never two cards and never a second set of changes. The review and the changes its output
 * proposes are stored in one transaction: applyReviewChanges lets the engine decide them for the sessions
 * the prompt labelled, logs every proposal and writes the accepted ones, and the stored notes are those
 * of the changes the engine applied or clamped (a rejected change drops its note). A change queues a
 * workout push after the commit. A timeout or Claude down before the last attempt stores nothing and
 * throws claude_unavailable, so pg-boss retries with backoff; the plan's usage limit stores nothing and
 * throws claude_plan_limited with the seconds to its reset, for the job to defer itself; a refusal,
 * max_tokens, invalid output, a rejected key or plan token, or a request Claude turned down store the
 * fallback card at once, which never changes the plan.
 */
export async function writeWeeklyReview(
  userId: string,
  weekStart: string,
  { lastAttempt, now = new Date() }: WriteWeeklyReviewOptions,
): Promise<WriteWeeklyReviewOutcome> {
  if ((await readReview(userId, weekStart))?.model) {
    return { status: "skipped", reason: "has_review" };
  }
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

  const active = await activePlan(db, userId);
  const week = await readReviewWeek(userId, weekStart, active);
  const { plan, labels } = await readReviewPlan(
    userId,
    weekStart,
    localDateOf(now, settings.timezone),
    active,
  );
  const result = await weeklyReview({
    credential,
    week,
    plan,
    settings: { units: settings.units, coachDetail: settings.coachDetail },
  });
  if (result.limited) {
    log.warn(
      {
        userId,
        weekStart,
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
    weekStart,
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
    planId: active?.id ?? null,
    promptVersion: result.promptVersion,
    model: result.model,
    usage: result.usage,
    fallbackReason: result.fallbackReason,
  };
  const content: StoredWeeklyReview = { card: result.content, summary: week.summary, notes: {} };
  let stored: { id: string; changed: boolean; changes: number } | null;
  try {
    stored = await db.transaction(async (tx) => {
      const [message] = await tx
        .insert(coachMessage)
        .values({ userId, kind: "weekly_review", weekStart, content, ...card })
        .onConflictDoUpdate({
          target: [coachMessage.userId, coachMessage.weekStart],
          targetWhere: sql`${coachMessage.kind} = 'weekly_review'`,
          // A new review: new thumbs, new date.
          set: { ...card, content, feedback: null, createdAt: sql`now()`, updatedAt: sql`now()` },
          // Only over a fallback card: the coach's review stays whatever finished second.
          setWhere: sql`${sql.identifier("coach_message")}.${sql.identifier("model")} is null`,
        })
        .returning({ id: coachMessage.id });
      if (!message) return null;
      if (result.changes.length === 0) return { id: message.id, changed: false, changes: 0 };
      const applied = await applyReviewChanges(tx, {
        userId,
        coachMessageId: message.id,
        weekStart,
        proposals: result.changes,
        labels,
        now,
      });
      const changes = Object.keys(applied.notes).length;
      if (changes > 0) {
        await tx
          .update(coachMessage)
          .set({ content: { ...content, notes: applied.notes } satisfies StoredWeeklyReview })
          .where(eq(coachMessage.id, message.id));
      }
      return { id: message.id, changed: applied.changed, changes };
    });
  } catch (error) {
    // The runner or the plan was deleted while Claude wrote: nothing to attach the review to.
    if (isForeignKeyViolation(error)) return { status: "skipped", reason: "gone" };
    throw error;
  }
  if (!stored) {
    log.info(context, "weekly review kept; another job stored it first");
    return { status: "skipped", reason: "has_review" };
  }
  const { id: coachMessageId, changed } = stored;
  log.info(
    { ...context, coachMessageId, proposed: result.changes.length, accepted: stored.changes },
    "weekly review stored",
  );
  if (changed) {
    try {
      await queueWorkoutPush(userId);
    } catch (err) {
      // The change is stored: the daily push sends it, so the review does not fail over the queue.
      log.error(
        { err, userId, weekStart, coachMessageId },
        "workout push not queued after a review change",
      );
    }
  }
  return { status: "stored", coachMessageId, fallbackReason: result.fallbackReason, changed };
}

/**
 * The stored review as the card shows it: its content and summary; the changes the engine applied or
 * clamped for it, dated as the sessions are now, by date, each with the coach's note; and the coming
 * week's sessions as they stand now, of the review's plan (the active plan once that one is gone) and
 * custom ones, skipped ones included.
 */
async function toCard(row: CoachMessage): Promise<WeeklyReviewCard> {
  // Written by writeWeeklyReview in this shape; the weekly-review check keeps week_start set.
  const stored = row.content as StoredWeeklyReview;
  const weekStart = row.weekStart!;
  const rows = await db
    .select({ adjustment: planAdjustment, date: planSession.date })
    .from(planAdjustment)
    .innerJoin(planSession, eq(planSession.id, planAdjustment.planSessionId))
    .where(
      and(
        eq(planAdjustment.coachMessageId, row.id),
        eq(planAdjustment.source, "review"),
        inArray(planAdjustment.outcome, ACCEPTED),
      ),
    )
    .orderBy(asc(planSession.date), asc(planSession.id));
  const changes: ReviewChange[] = rows.flatMap(({ adjustment, date }) => {
    const note = stored.notes[adjustment.planSessionId ?? ""];
    if (note === undefined) {
      // The note is stored in the same transaction as the change, so this is a bug, not a state.
      log.error(
        { coachMessageId: row.id, sessionId: adjustment.planSessionId },
        "review change without its note; left off the card",
      );
      return [];
    }
    return [{ ...toPlanChange(adjustment, date), note }];
  });
  const planId = row.planId ?? (await activePlan(db, row.userId))?.id ?? null;
  const coming = await sessionsBetween(db, {
    userId: row.userId,
    planId,
    ...comingWeekOf(weekStart),
  });
  return {
    id: row.id,
    weekStart,
    content: stored.card,
    summary: stored.summary,
    fallbackReason: row.fallbackReason,
    feedback: row.feedback,
    changes,
    comingWeek: coming.map((session) => ({
      id: session.id,
      date: session.date,
      type: session.type,
      title: session.title,
      status: session.status,
      source: session.planId === null ? "custom" : "plan",
      target: session.target,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * GET /api/reviews/latest, for Today: the review of the runner's last ended week, while the week after it
 * holds their today; else the job's state while it writes one (pending, or retrying after a failure or
 * while it waits for the Claude plan's reset); else none, also without a coach credential.
 */
export async function latestReview(
  userId: string,
  now: Date = new Date(),
): Promise<LatestReviewResponse> {
  const weekStart = lastEndedWeek(await runnerToday(db, userId, now));
  // The job's state before the review: a job that stores it and completes between the two reads is then
  // seen by the second. The other way round it is seen by neither, and the answer is none.
  const live = await weeklyReviewState(userId, weekStart);
  const row = await readReview(userId, weekStart);
  if (row) return { state: "ready", review: await toCard(row) };
  return live ?? { state: "none" };
}

/** GET /api/reviews: the runner's reviews, newest week first, at most REVIEW_LIST_MAX. */
export async function listReviews(userId: string): Promise<ReviewListResponse> {
  const rows = await db
    .select({
      id: coachMessage.id,
      weekStart: coachMessage.weekStart,
      content: coachMessage.content,
      fallbackReason: coachMessage.fallbackReason,
      createdAt: coachMessage.createdAt,
    })
    .from(coachMessage)
    .where(and(eq(coachMessage.userId, userId), eq(coachMessage.kind, "weekly_review")))
    .orderBy(desc(coachMessage.weekStart))
    .limit(REVIEW_LIST_MAX);
  return {
    reviews: rows.map((row) => ({
      id: row.id,
      weekStart: row.weekStart!,
      headline: (row.content as StoredWeeklyReview).card.headline,
      fallbackReason: row.fallbackReason,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** GET /api/reviews/:id: the runner's own weekly review, or 404. */
export async function getReview(userId: string, reviewId: string): Promise<ReviewResponse> {
  const [row] = await db
    .select()
    .from(coachMessage)
    .where(
      and(
        eq(coachMessage.id, reviewId),
        eq(coachMessage.userId, userId),
        eq(coachMessage.kind, "weekly_review"),
      ),
    );
  if (!row) throw reviewNotFound();
  return { review: await toCard(row) };
}

/** PUT /api/reviews/:id/feedback: thumbs up, down, or null to clear, on the runner's own review. */
export async function setReviewFeedback(
  userId: string,
  reviewId: string,
  feedback: CoachFeedback | null,
): Promise<ReviewResponse> {
  const [row] = await db
    .update(coachMessage)
    .set({ feedback })
    .where(
      and(
        eq(coachMessage.id, reviewId),
        eq(coachMessage.userId, userId),
        eq(coachMessage.kind, "weekly_review"),
      ),
    )
    .returning();
  if (!row) throw reviewNotFound();
  return { review: await toCard(row) };
}
