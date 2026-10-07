import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type ReviewWeekSummary,
  reviewWeekSummarySchema,
  type WeeklyReview,
  type WeeklyReviewOutput,
  weeklyReviewOutputSchema,
  weeklyReviewSchema,
} from "@running-coach/shared";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { type CoachMessage, coachMessage } from "../src/db/schema";
import type { StoredWeeklyReview } from "../src/services/weekly-review";

// Fictional rows for the weekly review's integration tests (slice 10): stored reviews and their reads.

/** A review card as the model writes one, parsed so it cannot drift from the contract. */
export const REVIEW_CARD: WeeklyReview = weeklyReviewSchema.parse({
  headline: "3 of 4 sessions done, 33.4 km against a planned 39.0 km.",
  whatHappened:
    "Tuesday's easy 8.1 km and Sunday's 16.2 km long run were done; Friday's easy run was missed.",
  whatItMeans: "86% of the planned distance at an easy heart rate: the load is right.",
  nextWeek: "4 sessions, 40.0 km, with a 17.0 km long run on Sunday.",
});

export const REVIEW_SUMMARY: ReviewWeekSummary = reviewWeekSummarySchema.parse({
  runs: 3,
  distanceM: 33_400,
  durationS: 11_200,
  sessionsPlanned: 4,
  sessionsDone: 3,
  plannedDistanceM: 39_000,
  paused: false,
});

/**
 * A stored weekly review of the user's for the week from `weekStart`, the model's by default; `stored`
 * replaces parts of its content (the card, the summary, the notes by session id).
 */
export async function createReview(
  userId: string,
  values: Partial<Omit<typeof coachMessage.$inferInsert, "userId" | "kind">> & {
    weekStart: string;
  },
  stored: Partial<StoredWeeklyReview> = {},
): Promise<CoachMessage> {
  const content: StoredWeeklyReview = {
    card: REVIEW_CARD,
    summary: REVIEW_SUMMARY,
    notes: {},
    ...stored,
  };
  const [row] = await db
    .insert(coachMessage)
    .values({
      userId,
      kind: "weekly_review",
      promptVersion: "weekly-review/v1",
      model: "claude-opus-5-5",
      content,
      ...values,
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/** The user's weekly reviews, oldest week first. */
export async function storedReviews(userId: string): Promise<CoachMessage[]> {
  return db
    .select()
    .from(coachMessage)
    .where(and(eq(coachMessage.userId, userId), eq(coachMessage.kind, "weekly_review")))
    .orderBy(asc(coachMessage.weekStart));
}

/** The content of a stored review. */
export function storedContent(row: CoachMessage): StoredWeeklyReview {
  return row.content as StoredWeeklyReview;
}

/** The output a weekly-review fixture of the fake Claude answers first: the card plus its changes. */
export function reviewFixtureOutput(fixture: string): WeeklyReviewOutput {
  const file = path.join(import.meta.dirname, `fixtures/claude/${fixture}.json`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    responses: [{ body: { content: [{ json: unknown }] } }];
  };
  return weeklyReviewOutputSchema.parse(parsed.responses[0].body.content[0].json);
}

/** The card a fixture's output stores: the changes never reach it. */
export function reviewCardOf(output: WeeklyReviewOutput): WeeklyReview {
  const { changes: _changes, ...card } = output;
  return card;
}
