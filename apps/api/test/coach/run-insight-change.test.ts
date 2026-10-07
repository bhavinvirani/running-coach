import { insightResponseSchema } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { coachMessage, planSession, type PlanSessionRow } from "../../src/db/schema";
import * as analyzeRunQueue from "../../src/jobs/analyze-run-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { config } from "../../src/lib/config";
import { analyzeRun, getInsight } from "../../src/services/insights";
import { cardOf, fixtureOutput, VALID_CARD } from "../fake-coach-service";
import {
  claudeKey,
  claudeRequests,
  connectGarmin,
  createPause,
  createPlan,
  createRunOn,
  createSession,
  createUser,
  setSettings,
  storedAdjustments,
  storedSession,
  TEMPO_STEPS,
} from "../seed";

// run-insight v2 on the key path against the fake Claude: the change the coach proposes for the next
// session goes to the engine in the card's own transaction, and the card shows it as applied. Today is
// Wednesday 2026-10-14 in UTC; the reviewed run is this morning's (the runner's newest), an easy 8 km is
// planned Thursday, and the Garmin login works. pg-boss runs without workers, so a queued push stays
// queued. The engine's rules and the change service alone are in test/services/coach-change.test.ts;
// the plan path in run-insight-plan.test.ts.

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
  await boss.createQueue(analyzeRunQueue.name, analyzeRunQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-10-14T10:00:00Z");
const TODAY = "2026-10-14";
const THURSDAY = "2026-10-15";

type SessionValues = Partial<Parameters<typeof createSession>[2]> & { planId?: null };

/** A runner on the fixture's key with this morning's run and Thursday's session (`next`). */
async function runner(fixture: string, next: SessionValues = {}, email?: string) {
  const userId = await createUser(email);
  const key = claudeKey(fixture);
  await setSettings(userId, { claudeKey: key });
  await connectGarmin(userId);
  const active = await createPlan(userId);
  const run = await createRunOn(userId, TODAY);
  const { planId, ...values } = next;
  const session = await createSession(userId, planId === null ? null : active.id, {
    date: THURSDAY,
    ...values,
  });
  return { userId, key, run, session };
}

async function analyze(userId: string, activityId: string, lastAttempt = false) {
  return analyzeRun(userId, activityId, { lastAttempt, now: NOW });
}

async function onlyCard(userId: string) {
  const rows = await db.select().from(coachMessage).where(eq(coachMessage.userId, userId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

/** The user message the fake Claude received in the key's first request. */
async function sentMessage(key: string): Promise<string> {
  const [request] = await claudeRequests(key);
  const messages = request?.body.messages as { content: string }[] | undefined;
  return messages?.[0]?.content ?? "";
}

/** The card a fixture's output stores, its nextStep the change's own. */
function changedCard(fixture: string) {
  const output = fixtureOutput(fixture);
  return { ...cardOf(output), nextStep: output.adjustment.nextStep };
}

async function expectUnchanged(session: PlanSessionRow) {
  const stored = await storedSession(session.id);
  expect({ ...stored, updatedAt: null }).toEqual({ ...session, updatedAt: null });
}

describe("analyzeRun with a plan change (run-insight v2)", () => {
  it("scales the next session in place, logs the change against its card, shows it on the card with the change's next step, and queues a push", async () => {
    const { userId, key, run, session } = await runner("adjust-scale");

    const outcome = await analyze(userId, run.id);

    const card = await onlyCard(userId);
    expect(outcome).toEqual({ status: "stored", coachMessageId: card.id, fallbackReason: null });
    expect(card).toMatchObject({
      promptVersion: "run-insight/v2",
      model: config.COACH_MODEL,
      content: changedCard("adjust-scale"),
    });
    expect(card.content).not.toHaveProperty("adjustment");
    const stored = await storedSession(session.id);
    expect(stored).toMatchObject({ id: session.id, type: "easy", status: "planned" });
    expect(stored.target.distanceM).toBe(6400);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        planSessionId: session.id,
        source: "coach",
        kind: "scale",
        outcome: "applied",
        reason: null,
        requested: { kind: "scale", factor: 0.8 },
        applied: { kind: "scale", factor: 0.8 },
        activityId: run.id,
        coachMessageId: card.id,
      }),
    ]);
    const insight = insightResponseSchema.parse(await getInsight(userId, run.id));
    expect(insight).toMatchObject({
      state: "ready",
      insight: {
        id: card.id,
        planChange: {
          sessionId: session.id,
          date: THURSDAY,
          kind: "scale",
          clamped: false,
          before: { type: "easy", status: "planned", target: session.target },
          after: { type: "easy", status: "planned", target: stored.target },
        },
      },
    });
    expect(await pushJobs(userId)).toHaveLength(1);
    const message = await sentMessage(key);
    expect(message).toContain("Previous run: none on record");
    expect(message).toMatch(/^Plan change for the next session: allowed$/m);
  });

  it("logs a factor far below the caps as clamped to 0.5 and shows the clamped change (clamped delta)", async () => {
    const { userId, run, session } = await runner("adjust-scale-far");

    await analyze(userId, run.id);

    const card = await onlyCard(userId);
    expect(card.content).toEqual(changedCard("adjust-scale-far"));
    expect((await storedSession(session.id)).target.distanceM).toBe(4000);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        outcome: "clamped",
        requested: { kind: "scale", factor: 0.2 },
        applied: { kind: "scale", factor: 0.5 },
      }),
    ]);
    expect(await getInsight(userId, run.id)).toMatchObject({
      insight: { planChange: { kind: "scale", clamped: true } },
    });
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("turns Thursday's tempo into an easy run of the same time (high heart rate)", async () => {
    const { userId, run, session } = await runner("adjust-easy", {
      type: "tempo",
      steps: TEMPO_STEPS,
    });

    await analyze(userId, run.id);

    const stored = await storedSession(session.id);
    expect(stored).toMatchObject({ type: "easy", status: "planned" });
    // The same time to the engine's rounding of the easy distance.
    expect(Math.abs(stored.target.durationS / session.target.durationS - 1)).toBeLessThan(0.02);
    expect(JSON.stringify(stored.steps)).not.toContain("threshold");
    expect((await onlyCard(userId)).content).toEqual(changedCard("adjust-easy"));
    expect(await storedAdjustments(userId)).toMatchObject([{ kind: "easy", outcome: "applied" }]);
  });

  it("skips Thursday's session for a rest, never made up, and keeps rest_and_check (unusual HR, illness)", async () => {
    const { userId, run, session } = await runner("adjust-rest");

    await analyze(userId, run.id);

    expect(await storedSession(session.id)).toMatchObject({ status: "skipped" });
    expect((await onlyCard(userId)).content).toMatchObject({
      caution: "rest_and_check",
      nextStep: fixtureOutput("adjust-rest").adjustment.nextStep,
    });
    expect(await storedAdjustments(userId)).toMatchObject([{ kind: "rest", outcome: "applied" }]);
  });

  it("changes nothing and logs nothing when the coach proposes none", async () => {
    const { userId, run, session } = await runner("valid");

    await analyze(userId, run.id);

    expect((await onlyCard(userId)).content).toEqual(VALID_CARD);
    await expectUnchanged(session);
    expect(await storedAdjustments(userId)).toEqual([]);
    expect(await getInsight(userId, run.id)).toMatchObject({ insight: { planChange: null } });
    expect(await pushJobs(userId)).toEqual([]);
  });

  describe("a rejected change stores the card with the plain next step, logs the rejection and changes nothing", () => {
    async function expectRejected(
      { userId, run, session }: { userId: string; run: { id: string }; session: PlanSessionRow },
      fixture: string,
      reason: string,
    ) {
      const outcome = await analyze(userId, run.id);

      const card = await onlyCard(userId);
      expect(outcome).toMatchObject({ status: "stored", fallbackReason: null });
      expect(card.content).toEqual(cardOf(fixtureOutput(fixture)));
      await expectUnchanged(session);
      expect(await storedAdjustments(userId)).toEqual([
        expect.objectContaining({
          source: "coach",
          outcome: "rejected",
          reason,
          applied: null,
          after: null,
          activityId: run.id,
          coachMessageId: card.id,
        }),
      ]);
      expect(await getInsight(userId, run.id)).toMatchObject({ insight: { planChange: null } });
      expect(await pushJobs(userId)).toEqual([]);
    }

    it("rejects as stale_run when Ask the coach reviews an older run (stale run)", async () => {
      const setup = await runner("adjust-scale");
      await createRunOn(setup.userId, TODAY, { startUtc: new Date("2026-10-14T09:00:00Z") });

      await expectRejected(setup, "adjust-scale", "stale_run");
      expect(await sentMessage(setup.key)).toContain(
        "Plan change for the next session: not allowed (only the newest run of the last 7 days can change the plan)",
      );
    });

    it("rejects as paused during an open pause and tells the coach about the pause (illness or injury pause)", async () => {
      const setup = await runner("adjust-rest");
      await createPause(setup.userId, { startedOn: TODAY, reason: "sick" });

      await expectRejected(setup, "adjust-rest", "paused");
      const message = await sentMessage(setup.key);
      expect(message).toContain("Training pause: sick since Wednesday 14 October 2026");
      expect(message).toContain(
        "Plan change for the next session: not allowed (training is paused)",
      );
    });

    it("rejects as paused when the runner pauses while Claude writes: the engine decides again in the transaction (illness or injury pause)", async () => {
      const setup = await runner("adjust-scale");
      const passThrough = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (input, init) => {
        await createPause(setup.userId, { startedOn: TODAY, reason: "injured" });
        return passThrough(input, init);
      });

      await expectRejected(setup, "adjust-scale", "paused");
      expect(await sentMessage(setup.key)).toMatch(/^Plan change for the next session: allowed$/m);
    });

    it.each([
      ["race", { type: "race" as const }, "the next session is a race"],
      ["custom", { planId: null }, "the next session is the runner's own workout"],
    ] as const)(
      "rejects as %s when the next session is a race or a custom workout",
      async (reason, next, words) => {
        const setup = await runner("adjust-scale", next);

        await expectRejected(setup, "adjust-scale", reason);
        expect(await sentMessage(setup.key)).toContain(
          `Plan change for the next session: not allowed (${words})`,
        );
      },
    );

    it("rejects a change without its own next step as invalid and keeps the plain next step (change without text)", async () => {
      const setup = await runner("adjust-scale-no-text");

      await expectRejected(setup, "adjust-scale-no-text", "invalid");
      expect((await storedAdjustments(setup.userId))[0]?.requested).toEqual({
        kind: "scale",
        factor: 0.8,
      });
    });

    it("rejects a scale without a factor as invalid and logs the proposal (factor null)", async () => {
      const setup = await runner("adjust-scale-null");

      await expectRejected(setup, "adjust-scale-null", "invalid");
      expect((await storedAdjustments(setup.userId))[0]?.requested).toEqual({
        kind: "scale",
        factor: null,
      });
    });
  });

  it("rejects as no_session and changes no other session when the runner skips the one the prompt saw while Claude writes (missed or moved sessions)", async () => {
    const { userId, run, session } = await runner("adjust-scale");
    const saturday = await createSession(userId, session.planId, { date: "2026-10-17" });
    const passThrough = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (input, init) => {
      await db.update(planSession).set({ status: "skipped" }).where(eq(planSession.id, session.id));
      return passThrough(input, init);
    });

    await analyze(userId, run.id);

    expect((await onlyCard(userId)).content).toEqual(cardOf(fixtureOutput("adjust-scale")));
    await expectUnchanged(saturday);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({ planSessionId: null, outcome: "rejected", reason: "no_session" }),
    ]);
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("applies one change when the job fires twice, one after the other or at once (a daily job firing twice)", async () => {
    const one = await runner("adjust-scale");

    await analyze(one.userId, one.run.id);
    expect(await analyze(one.userId, one.run.id)).toEqual({
      status: "skipped",
      reason: "has_card",
    });

    expect(await claudeRequests(one.key)).toHaveLength(1);
    expect(await storedAdjustments(one.userId)).toHaveLength(1);
    expect((await storedSession(one.session.id)).target.distanceM).toBe(6400);

    const other = await runner("adjust-scale", {}, "other@example.com");
    const outcomes = await Promise.all([
      analyze(other.userId, other.run.id),
      analyze(other.userId, other.run.id),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["skipped", "stored"]);
    expect(outcomes).toContainEqual({ status: "skipped", reason: "has_card" });
    expect(await storedAdjustments(other.userId)).toHaveLength(1);
    expect((await storedSession(other.session.id)).target.distanceM).toBe(6400);
    await onlyCard(other.userId);
  });

  it.each([
    ["timeout", "timeout", 1],
    ["key-invalid", "key_invalid", 1],
    ["unavailable", "unavailable", 2],
  ] as const)(
    "stores the fallback card and changes nothing on %s (Claude quota or timeout, invalid Claude key)",
    async (fixture, reason, calls) => {
      const { userId, key, run, session } = await runner(fixture);

      const outcome = await analyze(userId, run.id, true);

      expect(outcome).toMatchObject({ status: "stored", fallbackReason: reason });
      expect(await claudeRequests(key)).toHaveLength(calls);
      expect(await onlyCard(userId)).toMatchObject({ model: null, fallbackReason: reason });
      await expectUnchanged(session);
      expect(await storedAdjustments(userId)).toEqual([]);
      expect(await pushJobs(userId)).toEqual([]);
    },
  );
});
