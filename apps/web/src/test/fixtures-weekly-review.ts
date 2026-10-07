import {
  latestReviewResponseSchema,
  planSessionSchema,
  reviewChangeSchema,
  reviewListResponseSchema,
  reviewResponseSchema,
  weeklyReviewCardSchema,
  type CoachFallbackReason,
  type LatestReviewResponse,
  type PlanSession,
  type ReviewChange,
  type ReviewListResponse,
  type ReviewResponse,
  type ReviewSession,
  type SessionSnapshot,
  type WeeklyReviewCard,
} from "@running-coach/shared";
import { planSessionFixture, planSessionsFixture } from "@/test/fixtures";

// The weekly review's fixtures (slice 10): the coach's review of planFixture's first week (Mon 5 to Sun
// 11 Oct 2026), written on Mon 12 Oct, with the coming week 2 and the change it made to that week's long
// run, a fallback card, the latest-review states and the list of past reviews.

export const REVIEW_ID = "5e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b";

/** The reviewed week's Monday. */
export const REVIEW_WEEK_START = "2026-10-05";

/** When the fixture review was written: Mon 12 Oct 2026, 04:31 in London. */
const REVIEWED_AT = "2026-10-12T03:31:00Z";

function snapshotOf(session: PlanSession): SessionSnapshot {
  const { type, title, status, target } = session;
  return { type, title, status, target };
}

function reviewSessionOf(session: PlanSession): ReviewSession {
  const { id, date, type, title, status, source, target } = session;
  return { id, date, type, title, status, source, target };
}

/** The long run on Sun 18 Oct cut to 90% by the review: 16.2 km in 1:37:48 instead of 18.0 km. */
const SCALED_LONG_RUN_TARGET = { distanceM: 16200, durationS: 5868, zone: "easy" } as const;

/**
 * The long run on Sun 18 Oct as the review changed it, applied as proposed: 18.0 km to 16.2 km, with the
 * coach's note.
 */
export function reviewChangeFixture(overrides: Partial<ReviewChange> = {}): ReviewChange {
  const planned = planSessionFixture("2026-10-18");
  return reviewChangeSchema.parse({
    sessionId: planned.id,
    date: planned.date,
    kind: "scale",
    clamped: false,
    before: snapshotOf(planned),
    after: { ...snapshotOf(planned), target: SCALED_LONG_RUN_TARGET },
    note: "Two short runs last week: a slightly shorter long run lets you finish it strong.",
    ...overrides,
  });
}

/** planFixture's week 2 (Tue 13 to Sun 18 Oct) as the review left it: the long run cut to 16.2 km. */
export function comingWeekFixture(): ReviewSession[] {
  return planSessionsFixture()
    .filter((session) => session.date >= "2026-10-12" && session.date <= "2026-10-18")
    .map((session) =>
      reviewSessionOf(
        session.date === "2026-10-18" ? { ...session, target: SCALED_LONG_RUN_TARGET } : session,
      ),
    );
}

/**
 * The coach's review of planFixture's week 1 as the model wrote it, no thumbs yet: 31.4 of the planned
 * 38.0 km, 4 of 5 sessions in 3:04:12, and one change to the coming week. Parsed with the shared contract.
 */
export function weeklyReviewCardFixture(
  overrides: Partial<WeeklyReviewCard> = {},
): WeeklyReviewCard {
  return weeklyReviewCardSchema.parse({
    id: REVIEW_ID,
    weekStart: REVIEW_WEEK_START,
    content: {
      headline: "31.4 km of the planned 38.0 km, with 4 of 5 sessions done.",
      whatHappened:
        "You ran the easy runs, the intervals and the 14.0 km long run. Wednesday's strength session was missed and stays missed.",
      whatItMeans:
        "The long run held an even 6:05 /km, so the base is there. The missed session cost little.",
      nextWeek: "Week 2 builds to 38.6 km, with a tempo on Thursday and the long run on Sunday.",
    },
    summary: {
      runs: 4,
      distanceM: 31420,
      durationS: 11052,
      sessionsPlanned: 5,
      sessionsDone: 4,
      plannedDistanceM: 38030,
      paused: false,
    },
    fallbackReason: null,
    feedback: null,
    changes: [reviewChangeFixture()],
    comingWeek: comingWeekFixture(),
    createdAt: REVIEWED_AT,
    ...overrides,
  });
}

/**
 * The card built without the model (Claude not answering, unless given), from the week's numbers alone and
 * with no change to the plan: its middle part says why there is no review.
 */
export function fallbackReviewFixture(
  fallbackReason: CoachFallbackReason = "unavailable",
): WeeklyReviewCard {
  return weeklyReviewCardFixture({
    id: "8c7b6a59-4837-4261-9a5f-4e3d2c1b0a99",
    content: {
      headline: "31.4 km of the planned 38.0 km, with 4 of 5 sessions done.",
      whatHappened: "4 runs, 31.4 km in 3:04:12.",
      whatItMeans:
        "No coach review this week: Claude is not answering right now. These are the week's numbers only.",
      nextWeek: "Next week is planned at 38.6 km. Run it as written.",
    },
    fallbackReason,
    changes: [],
  });
}

/** GET /api/reviews/latest with a stored review: the model's unless another is given. */
export function latestReviewReadyFixture(
  review: WeeklyReviewCard = weeklyReviewCardFixture(),
): LatestReviewResponse {
  return latestReviewResponseSchema.parse({ state: "ready", review });
}

/** GET /api/reviews/:id and PUT /api/reviews/:id/feedback: the review, the model's unless given. */
export function reviewResponseFixture(
  review: WeeklyReviewCard = weeklyReviewCardFixture(),
): ReviewResponse {
  return reviewResponseSchema.parse({ review });
}

/**
 * GET /api/reviews: three past reviews, newest week first: the fixture review, the week before it as a
 * fallback card, and one from the turn of the year, whose range names both years.
 */
export function reviewListFixture(): ReviewListResponse {
  return reviewListResponseSchema.parse({
    reviews: [
      {
        id: REVIEW_ID,
        weekStart: REVIEW_WEEK_START,
        headline: weeklyReviewCardFixture().content.headline,
        fallbackReason: null,
        createdAt: REVIEWED_AT,
      },
      {
        id: "8c7b6a59-4837-4261-9a5f-4e3d2c1b0a99",
        weekStart: "2026-09-28",
        headline: "27.2 km in 4 runs, no plan yet.",
        fallbackReason: "unavailable",
        createdAt: "2026-10-05T03:31:00Z",
      },
      {
        id: "1a2b3c4d-5e6f-4789-8abc-def012345678",
        weekStart: "2025-12-29",
        headline: "18.5 km over the holidays, 3 easy runs.",
        fallbackReason: null,
        createdAt: "2026-01-05T03:31:00Z",
      },
    ],
  });
}

/**
 * The long run on Sun 18 Oct as the review cut it to 90% (planned 18.0 km, now 16.2 km), as the plan and
 * the calendar show it.
 */
export function reviewScaledSessionFixture(): PlanSession {
  const planned = planSessionFixture("2026-10-18");
  return planSessionSchema.parse({
    ...planned,
    target: SCALED_LONG_RUN_TARGET,
    steps: [{ kind: "run", zone: "easy", distanceM: 16200, durationS: null }],
    adjustment: {
      source: "review",
      kind: "scale",
      activityId: null,
      original: snapshotOf(planned),
      at: REVIEWED_AT,
    },
  });
}

/** The tempo on Thu 15 Oct as the review turned it into an easy run of the same 45:16: 7.5 km. */
export function reviewEasySessionFixture(): PlanSession {
  const planned = planSessionFixture("2026-10-15");
  return planSessionSchema.parse({
    ...planned,
    type: "easy",
    target: { distanceM: 7500, durationS: 2716, zone: "easy" },
    steps: [{ kind: "run", zone: "easy", distanceM: null, durationS: 2716 }],
    adjustment: {
      source: "review",
      kind: "easy",
      activityId: null,
      original: snapshotOf(planned),
      at: REVIEWED_AT,
    },
  });
}

/** The easy run on Fri 16 Oct as the review turned it into a rest: skipped. */
export function reviewRestSessionFixture(): PlanSession {
  const planned = planSessionFixture("2026-10-16");
  return planSessionSchema.parse({
    ...planned,
    status: "skipped",
    adjustment: {
      source: "review",
      kind: "rest",
      activityId: null,
      original: snapshotOf(planned),
      at: REVIEWED_AT,
    },
  });
}
