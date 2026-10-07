import { randomUUID } from "node:crypto";
import {
  latestReviewResponseSchema,
  reviewListResponseSchema,
  reviewResponseSchema,
} from "@running-coach/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { coachMessage } from "../../src/db/schema";
import { startBoss, stopBoss } from "../../src/jobs/boss";
import * as reviewQueue from "../../src/jobs/weekly-review-queue";
import { addDays, localDateOf } from "../../src/lib/local-date";
import { lastEndedWeek } from "../../src/services/weekly-review";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { createLongRun, createPlan, createSession, createUser, TEMPO_STEPS } from "../seed";
import { adjustedSession, createAdjustment } from "../seed-adaptation";
import { createReview, REVIEW_CARD, REVIEW_SUMMARY } from "../seed-weekly-review";

// The weekly review routes on the real Postgres. They read the runner's clock: the last ended week is
// computed from the real date in UTC (the runner's default zone), so the tests hold on any day. pg-boss
// runs without workers, so a queued job stays queued; the job is tested in test/jobs/weekly-review.test.ts.

const app = createTestApp();

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(reviewQueue.name, reviewQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

/** The Monday of the runner's last ended week, today. */
function lastWeek(): string {
  return lastEndedWeek(localDateOf(new Date(), "UTC"));
}

async function owner() {
  const agent = await signedInAgent(app);
  return { agent, userId: await ownerId() };
}

/**
 * The owner's review of the last ended week, with a plan around it: a scale clamped on the coming week's
 * Tuesday with its note, a rejected proposal for its Thursday tempo, and a custom workout on its Saturday.
 */
async function reviewedWeek(userId: string) {
  const weekStart = lastWeek();
  const active = await createPlan(userId, {
    startDate: addDays(weekStart, -14),
    endDate: addDays(weekStart, 70),
  });
  const tuesday = await createSession(userId, active.id, { date: addDays(weekStart, 8) });
  const tempo = await createSession(userId, active.id, {
    date: addDays(weekStart, 10),
    type: "tempo",
    steps: TEMPO_STEPS,
  });
  const custom = await createSession(userId, null, {
    date: addDays(weekStart, 12),
    title: "Hill strides",
  });
  const review = await createReview(
    userId,
    { weekStart, planId: active.id },
    { notes: { [tuesday.id]: "Run Tuesday a little longer, at an easy effort." } },
  );
  const before = adjustedSession(tuesday);
  const after = { ...before, target: { ...before.target, distanceM: 8300 } };
  await createAdjustment(userId, tuesday, {
    source: "review",
    outcome: "clamped",
    requested: { kind: "scale", factor: 1.3 },
    applied: { kind: "scale", factor: 1.0375 },
    before,
    after,
    coachMessageId: review.id,
  });
  await createAdjustment(userId, tempo, {
    source: "review",
    kind: "easy",
    outcome: "rejected",
    reason: "adjusted",
    requested: { kind: "easy" },
    applied: null,
    after: null,
    coachMessageId: review.id,
  });
  return { weekStart, review, tuesday, tempo, custom, before, after };
}

describe("GET /api/reviews/latest", () => {
  it("answers ready with the last ended week's review: its card and numbers, the changes the engine made with their notes, and the coming week as it stands", async () => {
    const { agent, userId } = await owner();
    const { weekStart, review, tuesday, tempo, custom, before, after } = await reviewedWeek(userId);

    const response = await agent.get("/api/reviews/latest");

    expect(response.status).toBe(200);
    expect(latestReviewResponseSchema.parse(response.body)).toEqual({
      state: "ready",
      review: {
        id: review.id,
        weekStart,
        content: REVIEW_CARD,
        summary: REVIEW_SUMMARY,
        fallbackReason: null,
        feedback: null,
        changes: [
          {
            sessionId: tuesday.id,
            date: tuesday.date,
            kind: "scale",
            clamped: true,
            before: { type: before.type, title: null, status: "planned", target: before.target },
            after: { type: after.type, title: null, status: "planned", target: after.target },
            note: "Run Tuesday a little longer, at an easy effort.",
          },
        ],
        comingWeek: [tuesday, tempo, custom].map((session) => ({
          id: session.id,
          date: session.date,
          type: session.type,
          title: session.title,
          status: session.status,
          source: session.planId === null ? "custom" : "plan",
          target: session.target,
        })),
        createdAt: review.createdAt.toISOString(),
      },
    });
  });

  it("answers none when only an older week's review is stored, and pending while this week's job waits", async () => {
    const { agent, userId } = await owner();
    await createReview(userId, { weekStart: addDays(lastWeek(), -7) });

    expect((await agent.get("/api/reviews/latest")).body).toEqual({ state: "none" });

    await reviewQueue.enqueueWeeklyReview({ userId, weekStart: lastWeek() });
    expect((await agent.get("/api/reviews/latest")).body).toEqual({ state: "pending" });
  });

  it("answers ready with a fallback card and its reason (invalid Claude key)", async () => {
    const { agent, userId } = await owner();
    await createReview(userId, {
      weekStart: lastWeek(),
      model: null,
      fallbackReason: "key_invalid",
    });

    const body = latestReviewResponseSchema.parse((await agent.get("/api/reviews/latest")).body);

    expect(body).toMatchObject({ state: "ready", review: { fallbackReason: "key_invalid" } });
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).get("/api/reviews/latest"), 401, "unauthorized");
  });
});

describe("GET /api/reviews", () => {
  it("lists the runner's past reviews newest week first, at most 52, without another runner's", async () => {
    const { agent, userId } = await owner();
    const other = await createUser("other@example.com");
    await createReview(other, { weekStart: lastWeek() });
    const newest = lastWeek();
    for (let week = 52; week >= 0; week -= 1) {
      await createReview(userId, {
        weekStart: addDays(newest, -7 * week),
        ...(week === 1 ? { model: null, fallbackReason: "timeout" as const } : {}),
      });
    }

    const response = await agent.get("/api/reviews");

    expect(response.status).toBe(200);
    const { reviews } = reviewListResponseSchema.parse(response.body);
    expect(reviews).toHaveLength(52);
    expect(reviews.map((review) => review.weekStart)).toEqual(
      Array.from({ length: 52 }, (_, week) => addDays(newest, -7 * week)),
    );
    expect(reviews[0]).toMatchObject({ headline: REVIEW_CARD.headline, fallbackReason: null });
    expect(reviews[1]).toMatchObject({ fallbackReason: "timeout" });
  });

  it("answers an empty list before the first review", async () => {
    const { agent } = await owner();

    expect((await agent.get("/api/reviews")).body).toEqual({ reviews: [] });
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).get("/api/reviews"), 401, "unauthorized");
  });
});

describe("GET /api/reviews/:id", () => {
  it("answers a past review as its card", async () => {
    const { agent, userId } = await owner();
    const review = await createReview(userId, { weekStart: addDays(lastWeek(), -21) });

    const response = await agent.get(`/api/reviews/${review.id}`);

    expect(response.status).toBe(200);
    expect(reviewResponseSchema.parse(response.body).review).toMatchObject({
      id: review.id,
      weekStart: addDays(lastWeek(), -21),
      changes: [],
      comingWeek: [],
    });
  });

  it("returns 404 for another runner's review, a run's insight and an unknown id", async () => {
    const { agent, userId } = await owner();
    const other = await createUser("other@example.com");
    const theirs = await createReview(other, { weekStart: lastWeek() });
    const run = await createLongRun(userId);
    const [insight] = await db
      .insert(coachMessage)
      .values({
        userId,
        kind: "insight",
        activityId: run.id,
        promptVersion: "run-insight/v2",
        content: {},
      })
      .returning({ id: coachMessage.id });

    for (const id of [theirs.id, insight!.id, randomUUID()]) {
      expectProblem(await agent.get(`/api/reviews/${id}`), 404, "not_found");
    }
  });

  it("returns 400 for an id that is not a uuid", async () => {
    const { agent } = await owner();

    expectProblem(await agent.get("/api/reviews/last-week"), 400, "validation");
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).get(`/api/reviews/${randomUUID()}`), 401, "unauthorized");
  });
});

describe("PUT /api/reviews/:id/feedback", () => {
  it("stores thumbs on the runner's review and clears them with null (thumbs stored)", async () => {
    const { agent, userId } = await owner();
    const review = await createReview(userId, { weekStart: lastWeek() });

    const up = await agent.put(`/api/reviews/${review.id}/feedback`).send({ feedback: "up" });

    expect(up.status).toBe(200);
    expect(reviewResponseSchema.parse(up.body).review.feedback).toBe("up");
    const latest = latestReviewResponseSchema.parse((await agent.get("/api/reviews/latest")).body);
    expect(latest).toMatchObject({ state: "ready", review: { feedback: "up" } });

    const cleared = await agent.put(`/api/reviews/${review.id}/feedback`).send({ feedback: null });
    expect(reviewResponseSchema.parse(cleared.body).review.feedback).toBeNull();
  });

  it("returns 400 for feedback outside the list", async () => {
    const { agent, userId } = await owner();
    const review = await createReview(userId, { weekStart: lastWeek() });

    expectProblem(
      await agent.put(`/api/reviews/${review.id}/feedback`).send({ feedback: "meh" }),
      400,
      "validation",
    );
  });

  it("returns 404 for another runner's review and leaves its thumbs alone", async () => {
    const { agent } = await owner();
    const other = await createUser("other@example.com");
    const theirs = await createReview(other, { weekStart: lastWeek() });

    expectProblem(
      await agent.put(`/api/reviews/${theirs.id}/feedback`).send({ feedback: "down" }),
      404,
      "not_found",
    );
    const [row] = await db.select().from(coachMessage);
    expect(row?.feedback).toBeNull();
  });

  it("returns 401 without a session", async () => {
    expectProblem(
      await request(app).put(`/api/reviews/${randomUUID()}/feedback`).send({ feedback: "up" }),
      401,
      "unauthorized",
    );
  });
});
