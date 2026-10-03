import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type CoachFallbackReason, insightResponseSchema } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { coachMessage } from "../../src/db/schema";
import * as analyzeRunQueue from "../../src/jobs/analyze-run-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import { askCoachLimiter } from "../../src/routes/insights";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { claudeKey, createLongRun, createUser, setSettings } from "../seed";

// The run screen's coach card. pg-boss runs without workers, so a queued analyze-run job stays queued;
// the job itself is tested in test/jobs/analyze-run.test.ts.

const app = createTestApp();

const validOutput = (
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "../fixtures/claude/valid.json"), "utf8"),
  ) as { responses: [{ body: { content: [{ json: unknown }] } }] }
).responses[0].body.content[0].json;

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(analyzeRunQueue.name, analyzeRunQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

beforeEach(async () => {
  // pg-boss's schema is not truncated between tests: start each with an empty queue.
  const jobs = await getBoss().findJobs(analyzeRunQueue.name);
  if (jobs.length > 0) {
    await getBoss().deleteJob(
      analyzeRunQueue.name,
      jobs.map((job) => job.id),
    );
  }
});

afterEach(() => {
  askCoachLimiter.reset();
  vi.restoreAllMocks();
});

async function owner({ key = false }: { key?: boolean } = {}) {
  const agent = await signedInAgent(app);
  const userId = await ownerId();
  if (key) await setSettings(userId, { claudeKey: claudeKey("valid") });
  const run = await createLongRun(userId);
  return { agent, userId, run };
}

async function storeCard(
  userId: string,
  activityId: string,
  fallbackReason: CoachFallbackReason | null = null,
) {
  const [row] = await db
    .insert(coachMessage)
    .values({
      userId,
      kind: "insight",
      activityId,
      promptVersion: "run-insight/v1",
      model: fallbackReason ? null : "claude-opus-5-5",
      content: validOutput,
      fallbackReason,
    })
    .returning();
  return row!;
}

async function runJobs(activityId: string) {
  return getBoss().findJobs(analyzeRunQueue.name, { key: activityId });
}

/** Queues the run's job, then fails its first attempt the way a timeout would. */
async function failOnce(userId: string, activityId: string) {
  const id = await analyzeRunQueue.enqueueAnalyzeRun({ userId, activityId });
  const [job] = await getBoss().fetch(analyzeRunQueue.name);
  expect(job?.id).toBe(id);
  await getBoss().fail(analyzeRunQueue.name, job!.id);
  return id!;
}

const insightPath = (id: string) => `/api/activities/${id}/insight`;

describe("GET /api/activities/:id/insight", () => {
  it("answers ready with the coach's card", async () => {
    const { agent, userId, run } = await owner({ key: true });
    const card = await storeCard(userId, run.id);

    const response = await agent.get(insightPath(run.id));

    expect(response.status).toBe(200);
    expect(insightResponseSchema.parse(response.body)).toEqual({
      state: "ready",
      insight: {
        id: card.id,
        content: validOutput,
        fallbackReason: null,
        feedback: null,
        createdAt: card.createdAt.toISOString(),
      },
    });
  });

  it("answers ready with the coach's card even while a job for the run waits", async () => {
    const { agent, userId, run } = await owner({ key: true });
    await storeCard(userId, run.id);
    await analyzeRunQueue.enqueueAnalyzeRun({ userId, activityId: run.id });

    const response = await agent.get(insightPath(run.id));

    expect(response.body).toMatchObject({ state: "ready", insight: { fallbackReason: null } });
  });

  it("answers pending while the run's job waits or runs", async () => {
    const { agent, userId, run } = await owner({ key: true });
    await analyzeRunQueue.enqueueAnalyzeRun({ userId, activityId: run.id });

    expect((await agent.get(insightPath(run.id))).body).toEqual({ state: "pending" });

    await getBoss().fetch(analyzeRunQueue.name);
    expect((await runJobs(run.id))[0]?.state).toBe("active");
    expect((await agent.get(insightPath(run.id))).body).toEqual({ state: "pending" });
  });

  it("answers retrying once the job failed and waits out its backoff, and while it runs again (Claude quota or timeout)", async () => {
    const { agent, userId, run } = await owner({ key: true });
    await failOnce(userId, run.id);
    expect((await runJobs(run.id))[0]?.state).toBe("retry");

    expect((await agent.get(insightPath(run.id))).body).toEqual({ state: "retrying" });

    const [again] = await getBoss().fetch(analyzeRunQueue.name, { ignoreStartAfter: true });
    expect(again).toMatchObject({ retryCount: 1 });
    expect((await agent.get(insightPath(run.id))).body).toEqual({ state: "retrying" });
  });

  it("answers ready, not none, when the job stores its card and completes while the run screen reads (a race with the job)", async () => {
    const { agent, userId, run } = await owner({ key: true });
    const id = await analyzeRunQueue.enqueueAnalyzeRun({ userId, activityId: run.id });
    await getBoss().fetch(analyzeRunQueue.name);
    const boss = getBoss();
    const findJobs = boss.findJobs.bind(boss);
    // The job finishes just as getInsight reads the job's state.
    vi.spyOn(boss, "findJobs").mockImplementationOnce(async (...args) => {
      await storeCard(userId, run.id);
      await boss.complete(analyzeRunQueue.name, id!);
      return findJobs(...args);
    });

    const response = await agent.get(insightPath(run.id));

    expect(response.body).toMatchObject({ state: "ready", insight: { fallbackReason: null } });
  });

  it("answers ready with the fallback card when no job is live", async () => {
    const { agent, userId, run } = await owner({ key: true });
    await storeCard(userId, run.id, "timeout");

    const response = await agent.get(insightPath(run.id));

    expect(response.body).toMatchObject({ state: "ready", insight: { fallbackReason: "timeout" } });
  });

  it("answers pending over a fallback card while Try again's job waits", async () => {
    const { agent, userId, run } = await owner({ key: true });
    await storeCard(userId, run.id, "key_invalid");
    await analyzeRunQueue.enqueueAnalyzeRun({ userId, activityId: run.id });

    expect((await agent.get(insightPath(run.id))).body).toEqual({ state: "pending" });
  });

  it("answers no_key for a run without a card when the user has no Claude key, and queues nothing", async () => {
    const { agent, run } = await owner();

    expect((await agent.get(insightPath(run.id))).body).toEqual({ state: "no_key" });
    expect(await runJobs(run.id)).toEqual([]);
  });

  it("answers none for a run without a card or job when a key is set (an imported or older run)", async () => {
    const { agent, run } = await owner({ key: true });

    expect((await agent.get(insightPath(run.id))).body).toEqual({ state: "none" });
  });

  it("returns 404 for another user's run, even when it has a card", async () => {
    const { agent } = await owner({ key: true });
    const otherId = await createUser("other@example.com");
    const othersRun = await createLongRun(otherId);
    await storeCard(otherId, othersRun.id);

    expectProblem(await agent.get(insightPath(othersRun.id)), 404, "not_found");
    expectProblem(await agent.get(insightPath(randomUUID())), 404, "not_found");
  });

  it("returns 400 validation for an id that is not a uuid", async () => {
    const { agent } = await owner();

    expectProblem(await agent.get(insightPath("latest")), 400, "validation");
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).get(insightPath(randomUUID())), 401, "unauthorized");
  });
});

describe("POST /api/activities/:id/insight", () => {
  it("queues the run's job and answers pending", async () => {
    const { agent, userId, run } = await owner({ key: true });

    const response = await agent.post(insightPath(run.id));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: "pending" });
    const jobs = await runJobs(run.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      state: "created",
      data: { userId, activityId: run.id },
      singletonKey: run.id,
    });
  });

  it("folds a second tap into the waiting job (duplicate request)", async () => {
    const { agent, run } = await owner({ key: true });

    await agent.post(insightPath(run.id));
    const second = await agent.post(insightPath(run.id));

    expect(second.body).toEqual({ state: "pending" });
    expect(await runJobs(run.id)).toHaveLength(1);
  });

  it("answers ready and queues nothing when the coach's card exists", async () => {
    const { agent, userId, run } = await owner({ key: true });
    const card = await storeCard(userId, run.id);

    const response = await agent.post(insightPath(run.id));

    expect(response.body).toMatchObject({ state: "ready", insight: { id: card.id } });
    expect(await runJobs(run.id)).toEqual([]);
  });

  it("queues a job for a run with a fallback card (Try again)", async () => {
    const { agent, userId, run } = await owner({ key: true });
    await storeCard(userId, run.id, "unavailable");

    const response = await agent.post(insightPath(run.id));

    expect(response.body).toEqual({ state: "pending" });
    expect(await runJobs(run.id)).toHaveLength(1);
  });

  it("returns 409 claude_key_missing and queues nothing without a key", async () => {
    const { agent, run } = await owner();

    const response = await agent.post(insightPath(run.id));

    expectProblem(response, 409, "claude_key_missing");
    expect(await runJobs(run.id)).toEqual([]);
  });

  it("returns 404 for another user's run and queues nothing", async () => {
    const { agent } = await owner({ key: true });
    const othersRun = await createLongRun(await createUser("other@example.com"));

    expectProblem(await agent.post(insightPath(othersRun.id)), 404, "not_found");
    expect(await runJobs(othersRun.id)).toEqual([]);
  });

  it("returns 429 with Retry-After after six asks in a minute", async () => {
    const { agent, run } = await owner({ key: true });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await agent.post(insightPath(run.id))).status).toBe(200);
    }

    const response = await agent.post(insightPath(run.id));

    expectProblem(response, 429, "rate_limited");
    expect(response.headers["retry-after"]).toBeDefined();
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).post(insightPath(randomUUID())), 401, "unauthorized");
  });
});

describe("PUT /api/insights/:id/feedback", () => {
  const feedbackPath = (id: string) => `/api/insights/${id}/feedback`;

  it("sets thumbs up, then down, then clears them, answering the card each time", async () => {
    const { agent, userId, run } = await owner({ key: true });
    const card = await storeCard(userId, run.id);

    for (const feedback of ["up", "down", null] as const) {
      const response = await agent.put(feedbackPath(card.id)).send({ feedback });

      expect(response.status).toBe(200);
      expect(insightResponseSchema.parse(response.body)).toMatchObject({
        state: "ready",
        insight: { id: card.id, feedback },
      });
      const [stored] = await db.select().from(coachMessage).where(eq(coachMessage.id, card.id));
      expect(stored?.feedback).toBe(feedback);
    }
  });

  it("returns 404 for another user's card or an unknown id and changes nothing", async () => {
    const { agent } = await owner({ key: true });
    const otherId = await createUser("other@example.com");
    const othersCard = await storeCard(otherId, (await createLongRun(otherId)).id);

    expectProblem(
      await agent.put(feedbackPath(othersCard.id)).send({ feedback: "up" }),
      404,
      "not_found",
    );
    expectProblem(
      await agent.put(feedbackPath(randomUUID())).send({ feedback: "up" }),
      404,
      "not_found",
    );
    const [stored] = await db.select().from(coachMessage).where(eq(coachMessage.id, othersCard.id));
    expect(stored?.feedback).toBeNull();
  });

  it("returns 400 validation for a value outside up, down and null", async () => {
    const { agent, userId, run } = await owner({ key: true });
    const card = await storeCard(userId, run.id);

    expectProblem(
      await agent.put(feedbackPath(card.id)).send({ feedback: "meh" }),
      400,
      "validation",
    );
    expectProblem(await agent.put(feedbackPath(card.id)).send({}), 400, "validation");
  });

  it("returns 401 without a session", async () => {
    expectProblem(
      await request(app).put(feedbackPath(randomUUID())).send({ feedback: "up" }),
      401,
      "unauthorized",
    );
  });
});
