import { z } from "zod";
import { coachFallbackReasonSchema, coachFeedbackSchema } from "./coach";
import {
  planChangeSchema,
  SESSION_TITLE_MAX,
  sessionSourceSchema,
  sessionStatusSchema,
  sessionTargetSchema,
  sessionTypeSchema,
} from "./plan";

// The coach's weekly review (slice 10): written once per runner per Monday-to-Sunday week after it ends,
// with up to REVIEW_CHANGES_MAX changes to the coming week's sessions that the engine accepts, clamps or
// rejects like a run insight's.

/** The most changes one review may propose; more fails the output's parse, as an over-long field does. */
export const REVIEW_CHANGES_MAX = 3;
export const REVIEW_NOTE_MAX = 200;

/**
 * The coach's card for one week, written by Claude or built as the fallback card in the same shape. Small
 * and flat so structured outputs can hold it; the API checks the length limits after the model answers.
 */
export const weeklyReviewSchema = z
  .object({
    /** One sentence with the week's main number. */
    headline: z.string().min(1).max(120),
    whatHappened: z.string().min(1).max(400),
    whatItMeans: z.string().min(1).max(400),
    /** The coming week as planned, true without any change: a change carries its own note. */
    nextWeek: z.string().min(1).max(400),
  })
  .strict();
export type WeeklyReview = z.infer<typeof weeklyReviewSchema>;

/** scale: the session times a factor. easy: a quality session as an easy run of the same time. rest: skip it. */
export const reviewChangeKindSchema = z.enum(["scale", "easy", "rest"]);
export type ReviewChangeKind = z.infer<typeof reviewChangeKindSchema>;

/** One change the review proposes for a session of the coming week (weekly-review v1). */
export const reviewChangeProposalSchema = z
  .object({
    /** The session's label in the prompt ("s1"); a label the prompt did not give is rejected no_session. */
    session: z.string().min(1).max(8),
    kind: reviewChangeKindSchema,
    /** For scale: the share of the planned session, 0.5 to 1.1; the engine clamps anything outside its caps. */
    factor: z.number().nullable(),
    /**
     * What to tell the runner about this change, without the new numbers, which the app shows from the
     * engine. A rejected change drops it with the change.
     */
    note: z.string().min(1).max(REVIEW_NOTE_MAX),
  })
  .strict();
export type ReviewChangeProposal = z.infer<typeof reviewChangeProposalSchema>;

/**
 * What Claude returns for a week from weekly-review v1: the card plus the changes it proposes, none in an
 * empty list. The API stores the card and the notes of the changes the engine applied.
 */
export const weeklyReviewOutputSchema = weeklyReviewSchema
  .extend({ changes: z.array(reviewChangeProposalSchema).max(REVIEW_CHANGES_MAX) })
  .strict();
export type WeeklyReviewOutput = z.infer<typeof weeklyReviewOutputSchema>;

/** The reviewed week in numbers, as they stood when the review was written. */
export const reviewWeekSummarySchema = z
  .object({
    /** Runs on the week's local dates. */
    runs: z.number().int().nonnegative(),
    distanceM: z.number().int().nonnegative(),
    durationS: z.number().int().nonnegative(),
    /** The week's sessions that were not skipped, plan and custom. */
    sessionsPlanned: z.number().int().nonnegative(),
    sessionsDone: z.number().int().nonnegative(),
    /** Target distance of those sessions. */
    plannedDistanceM: z.number().int().nonnegative(),
    /** A pause covered at least one of the week's days. */
    paused: z.boolean(),
  })
  .strict();
export type ReviewWeekSummary = z.infer<typeof reviewWeekSummarySchema>;

/** One change the review made to a session, as the engine applied or clamped it, with the coach's note. */
export const reviewChangeSchema = planChangeSchema
  .extend({ note: z.string().min(1).max(REVIEW_NOTE_MAX) })
  .strict();
export type ReviewChange = z.infer<typeof reviewChangeSchema>;

/** A session of the coming week as it stands now: the card's preview. */
export const reviewSessionSchema = z
  .object({
    id: z.uuid(),
    date: z.iso.date(),
    type: sessionTypeSchema,
    title: z.string().min(1).max(SESSION_TITLE_MAX).nullable(),
    status: sessionStatusSchema,
    source: sessionSourceSchema,
    target: sessionTargetSchema,
  })
  .strict();
export type ReviewSession = z.infer<typeof reviewSessionSchema>;

/** A stored weekly review. */
export const weeklyReviewCardSchema = z
  .object({
    id: z.uuid(),
    /** The reviewed week's Monday, a local date. */
    weekStart: z.iso.date(),
    content: weeklyReviewSchema,
    summary: reviewWeekSummarySchema,
    /** Null when the model wrote the card. */
    fallbackReason: coachFallbackReasonSchema.nullable(),
    feedback: coachFeedbackSchema.nullable(),
    /** The changes the engine applied or clamped, by date; a rejected proposal is never shown. */
    changes: z.array(reviewChangeSchema),
    /** The sessions of the week after weekStart, plan and custom, by date, skipped ones included. */
    comingWeek: z.array(reviewSessionSchema),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type WeeklyReviewCard = z.infer<typeof weeklyReviewCardSchema>;

/**
 * GET /api/reviews/latest, for Today. ready: the newest review, while its coming week holds the runner's
 * today. pending: the coach is writing the review of the week that just ended. retrying: Claude failed and
 * the job tries again later; resumesAt when it waits for the Claude plan's usage limit to reset. none:
 * nothing to show (no review for this week, or no coach credential).
 */
export const latestReviewResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), review: weeklyReviewCardSchema }).strict(),
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("retrying"), resumesAt: z.iso.datetime().optional() }).strict(),
  z.object({ state: z.literal("none") }).strict(),
]);
export type LatestReviewResponse = z.infer<typeof latestReviewResponseSchema>;

/** One past review in the list. */
export const reviewListItemSchema = z
  .object({
    id: z.uuid(),
    weekStart: z.iso.date(),
    headline: z.string().min(1).max(120),
    fallbackReason: coachFallbackReasonSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type ReviewListItem = z.infer<typeof reviewListItemSchema>;

/** GET /api/reviews: the runner's reviews, newest week first. */
export const reviewListResponseSchema = z
  .object({ reviews: z.array(reviewListItemSchema) })
  .strict();
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>;

/** GET /api/reviews/:id, and PUT /api/reviews/:id/feedback's answer. */
export const reviewResponseSchema = z.object({ review: weeklyReviewCardSchema }).strict();
export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

export const reviewParamsSchema = z.object({ id: z.uuid() }).strict();
export type ReviewParams = z.infer<typeof reviewParamsSchema>;

/** PUT /api/reviews/:id/feedback: thumbs up, down, or null to clear. */
export const reviewFeedbackRequestSchema = z
  .object({ feedback: coachFeedbackSchema.nullable() })
  .strict();
export type ReviewFeedbackRequest = z.infer<typeof reviewFeedbackRequestSchema>;
