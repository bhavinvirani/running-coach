import { randomUUID } from "node:crypto";
import type { PlanDelta } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity, coachMessage, planSession } from "../../src/db/schema";
import {
  applyCoachChange,
  coachChangeTarget,
  planChangesFor,
} from "../../src/services/coach-change";
import { endPause } from "../../src/services/pause";
import {
  createAdjustment,
  createPause,
  createPlan,
  createRunOn,
  createSession,
  createUser,
  storedAdjustments,
  storedSession,
  TEMPO_STEPS,
} from "../seed";

// The coach's change to the plan after a run (slice 9), on the real Postgres: the target asked for before
// the Claude call, the change applied in the caller's transaction, and the cards' mapping. Today is
// Wednesday 2026-10-14 in UTC; the reviewed run is this morning's, and an easy 8 km is planned Thursday.

const NOW = new Date("2026-10-14T10:00:00Z");
const TODAY = "2026-10-14";
const THURSDAY = "2026-10-15";

/** The runner with an active plan, this morning's run and an easy 8 km on Thursday (or `next`). */
async function runner(
  next: Partial<Parameters<typeof createSession>[2]> | null = {},
  run: Parameters<typeof createRunOn>[2] = {},
  planValues: Parameters<typeof createPlan>[1] = {},
) {
  const userId = await createUser();
  const active = await createPlan(userId, planValues);
  const reviewed = await createRunOn(userId, TODAY, run);
  const session =
    next === null ? null : await createSession(userId, active.id, { date: THURSDAY, ...next });
  return { userId, planId: active.id, run: reviewed, session };
}

/** The coach's card for the run, as the insight job stores it before applying the change. */
async function coachCard(userId: string, activityId: string): Promise<string> {
  const [row] = await db
    .insert(coachMessage)
    .values({
      userId,
      kind: "insight",
      activityId,
      promptVersion: "run-insight/v2",
      model: "claude-opus-5-5",
      content: {},
    })
    .returning({ id: coachMessage.id });
  return row!.id;
}

const CHANGED_STEP = "Keep Thursday's run a little shorter than planned.";

/**
 * The change as the insight job applies it: the session the prompt saw (coachChangeTarget now, unless
 * `sessionId` names it) and the change's own next step.
 */
async function apply(
  userId: string,
  activityId: string,
  delta: PlanDelta,
  {
    now = NOW,
    sessionId,
    nextStep = CHANGED_STEP,
  }: { now?: Date; sessionId?: string | null; nextStep?: string | null } = {},
) {
  const seen =
    sessionId === undefined
      ? (await coachChangeTarget(userId, activityId, now)).sessionId
      : sessionId;
  const coachMessageId = await coachCard(userId, activityId);
  const result = await db.transaction((tx) =>
    applyCoachChange(tx, {
      userId,
      activityId,
      coachMessageId,
      sessionId: seen,
      delta,
      nextStep,
      now,
    }),
  );
  return { coachMessageId, result };
}

describe("coachChangeTarget", () => {
  it("allows a change to the first session after the run's date, a plan session before a custom one", async () => {
    const { userId, planId, run, session } = await runner();
    await createSession(userId, null, { date: THURSDAY, title: "Strides" });
    await createSession(userId, planId, { date: TODAY });
    await createSession(userId, planId, { date: "2026-10-17" });

    expect(await coachChangeTarget(userId, run.id, NOW)).toEqual({
      allowed: true,
      reason: null,
      sessionId: session!.id,
    });
  });

  it("takes the next session from today on: a session missed between the run and today is history (missed sessions)", async () => {
    const userId = await createUser();
    const active = await createPlan(userId);
    const run = await createRunOn(userId, "2026-10-12");
    await createSession(userId, active.id, { date: "2026-10-13", status: "missed" });
    await createSession(userId, active.id, { date: "2026-10-13", status: "planned" });
    const today = await createSession(userId, active.id, { date: TODAY, status: "moved" });

    expect((await coachChangeTarget(userId, run.id, NOW)).sessionId).toBe(today.id);
  });

  it("refuses with stale_run for a run that is not the runner's newest (stale run)", async () => {
    const { userId, run } = await runner();
    await createRunOn(userId, TODAY, { startUtc: new Date("2026-10-14T09:00:00Z") });

    expect(await coachChangeTarget(userId, run.id, NOW)).toEqual({
      allowed: false,
      reason: "stale_run",
      sessionId: null,
    });
  });

  it("refuses with stale_run for the newest run once it started more than 7 days ago (stale run)", async () => {
    const { userId, run } = await runner();

    const target = await coachChangeTarget(userId, run.id, new Date("2026-10-21T08:00:01Z"));

    expect(target).toMatchObject({ allowed: false, reason: "stale_run" });
    expect(
      (await coachChangeTarget(userId, run.id, new Date("2026-10-21T08:00:00Z"))).reason,
    ).not.toBe("stale_run");
  });

  it("refuses with paused during an open pause (illness or injury pause)", async () => {
    const { userId, run } = await runner();
    await createPause(userId, { startedOn: TODAY });

    expect(await coachChangeTarget(userId, run.id, NOW)).toMatchObject({
      allowed: false,
      reason: "paused",
    });
  });

  it("refuses with no_session without a session after the run, without an active plan, or for a run before the plan's start", async () => {
    const nothingNext = await runner(null);
    expect((await coachChangeTarget(nothingNext.userId, nothingNext.run.id, NOW)).reason).toBe(
      "no_session",
    );

    const userId = await createUser("before-plan@example.com");
    await createPlan(userId, { startDate: "2026-10-19" });
    const early = await createRunOn(userId, TODAY);
    expect((await coachChangeTarget(userId, early.id, NOW)).reason).toBe("no_session");
  });

  it.each([
    ["custom", { planId: null }],
    ["race", { type: "race" as const }],
  ])("refuses with %s when the next session is that", async (reason, values) => {
    const userId = await createUser();
    const active = await createPlan(userId);
    const run = await createRunOn(userId, TODAY);
    const next = await createSession(userId, "planId" in values ? null : active.id, {
      date: THURSDAY,
      ...("type" in values ? { type: values.type } : {}),
    });

    expect(await coachChangeTarget(userId, run.id, NOW)).toEqual({
      allowed: false,
      reason,
      sessionId: next.id,
    });
  });

  it("refuses with adjusted for a session the coach already changed, not one a re-entry eased", async () => {
    const { userId, session, run } = await runner();
    const earlier = await createRunOn(userId, "2026-10-12");
    await createAdjustment(userId, session, {
      source: "gap",
      kind: "re_entry",
      activityId: earlier.id,
    });
    expect((await coachChangeTarget(userId, run.id, NOW)).allowed).toBe(true);

    await createAdjustment(userId, session, { activityId: earlier.id });

    expect((await coachChangeTarget(userId, run.id, NOW)).reason).toBe("adjusted");
  });
});

describe("applyCoachChange", () => {
  it("scales the next session, logs the change against the run and its card, and answers what changed", async () => {
    const { userId, run, session } = await runner();

    const { coachMessageId, result } = await apply(userId, run.id, { kind: "scale", factor: 0.8 });

    const stored = await storedSession(session!.id);
    expect(stored.target.distanceM).toBe(6400);
    expect(result).toEqual({
      outcome: "applied",
      reason: null,
      planChange: {
        sessionId: session!.id,
        date: THURSDAY,
        kind: "scale",
        clamped: false,
        before: { type: "easy", title: null, status: "planned", target: session!.target },
        after: { type: "easy", title: null, status: "planned", target: stored.target },
      },
      changed: true,
    });
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        planSessionId: session!.id,
        source: "coach",
        kind: "scale",
        outcome: "applied",
        reason: null,
        requested: { kind: "scale", factor: 0.8 },
        applied: { kind: "scale", factor: 0.8 },
        activityId: run.id,
        coachMessageId,
        before: expect.objectContaining({ steps: session!.steps }) as unknown,
        after: expect.objectContaining({ steps: stored.steps }) as unknown,
      }),
    ]);
  });

  it("clamps a cut below half to half and logs it clamped (clamped delta)", async () => {
    const { userId, run, session } = await runner();

    const { result } = await apply(userId, run.id, { kind: "scale", factor: 0.2 });

    expect(result).toMatchObject({
      outcome: "clamped",
      changed: true,
      planChange: { clamped: true },
    });
    expect((await storedSession(session!.id)).target.distanceM).toBe(4000);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        outcome: "clamped",
        requested: { kind: "scale", factor: 0.2 },
        applied: { kind: "scale", factor: 0.5 },
      }),
    ]);
  });

  it("clamps a rise at 110% of the longest run of the last 30 days, with no weekly cap in the plan's first week (clamped delta)", async () => {
    const { userId, run, session } = await runner(
      {},
      { distanceM: 7500 },
      { startDate: "2026-10-12" },
    );

    const { result } = await apply(userId, run.id, { kind: "scale", factor: 1.1 });

    expect(result.outcome).toBe("clamped");
    const distanceM = (await storedSession(session!.id)).target.distanceM;
    expect(distanceM).toBeGreaterThan(8000);
    expect(distanceM).toBeLessThanOrEqual(8250);
  });

  it("turns a quality session into an easy run of the same time", async () => {
    const { userId, run, session } = await runner({ type: "tempo", steps: TEMPO_STEPS });

    const { result } = await apply(userId, run.id, { kind: "easy" });

    expect(result.planChange).toMatchObject({
      kind: "easy",
      before: { type: "tempo" },
      after: { type: "easy" },
    });
    expect((await storedSession(session!.id)).type).toBe("easy");
  });

  it("skips the next session for a rest, never made up", async () => {
    const { userId, run, session } = await runner();

    const { result } = await apply(userId, run.id, { kind: "rest" });

    expect(result.planChange).toMatchObject({ kind: "rest", after: { status: "skipped" } });
    expect(await storedSession(session!.id)).toMatchObject({ date: THURSDAY, status: "skipped" });
  });

  it("rejects a change to a race, logs it with its reason and changes nothing (rejected delta)", async () => {
    const { userId, run, session } = await runner({ type: "race" });

    const { result } = await apply(userId, run.id, { kind: "scale", factor: 0.8 });

    expect(result).toEqual({
      outcome: "rejected",
      reason: "race",
      planChange: null,
      changed: false,
    });
    expect(await storedSession(session!.id)).toEqual(session);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        planSessionId: session!.id,
        outcome: "rejected",
        reason: "race",
        requested: { kind: "scale", factor: 0.8 },
        applied: null,
        after: null,
      }),
    ]);
  });

  it("logs a proposal with nothing planned after the run as rejected no_session", async () => {
    const { userId, run } = await runner(null);

    const { result } = await apply(userId, run.id, { kind: "rest" });

    expect(result.reason).toBe("no_session");
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({ planSessionId: null, outcome: "rejected", reason: "no_session" }),
    ]);
  });

  it("changes nothing on a second call for the run and answers the stored outcome (insight job retry)", async () => {
    const { userId, run, session } = await runner();
    const first = await apply(userId, run.id, { kind: "scale", factor: 0.8 });
    const scaled = await storedSession(session!.id);

    const second = await db.transaction((tx) =>
      applyCoachChange(tx, {
        userId,
        activityId: run.id,
        coachMessageId: first.coachMessageId,
        sessionId: session!.id,
        delta: { kind: "rest" },
        nextStep: "Rest on Thursday.",
        now: NOW,
      }),
    );

    expect(second).toEqual({ ...first.result, changed: false });
    expect(await storedSession(session!.id)).toEqual(scaled);
    expect(await storedAdjustments(userId)).toHaveLength(1);
  });

  it("decides again in the transaction: a pause started during the Claude call rejects the change (illness or injury pause)", async () => {
    const { userId, run, session } = await runner();
    expect((await coachChangeTarget(userId, run.id, NOW)).allowed).toBe(true);
    await createPause(userId, { startedOn: TODAY });

    const { result } = await apply(userId, run.id, { kind: "scale", factor: 0.8 });

    expect(result).toMatchObject({ outcome: "rejected", reason: "paused" });
    expect(await storedSession(session!.id)).toEqual(session);
  });

  it("rejects a run deleted during the Claude call as stale and logs nothing (deleted activity)", async () => {
    const { userId, run, session } = await runner();
    await db.delete(activity).where(eq(activity.id, run.id));

    const result = await db.transaction((tx) =>
      applyCoachChange(tx, {
        userId,
        activityId: run.id,
        coachMessageId: randomUUID(),
        sessionId: session!.id,
        delta: { kind: "rest" },
        nextStep: "Rest on Thursday.",
        now: NOW,
      }),
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: "stale_run",
      planChange: null,
      changed: false,
    });
    expect(await storedSession(session!.id)).toEqual(session);
    expect(await storedAdjustments(userId)).toEqual([]);
  });
});

describe("applyCoachChange on the session the prompt saw", () => {
  it.each([
    ["skipped", { status: "skipped" as const }],
    ["moved past the next one", { date: "2026-10-18", status: "moved" as const }],
  ])(
    "rejects as no_session and changes nothing when the session the prompt saw was %s during the Claude call (missed or moved sessions)",
    async (_, change) => {
      const { userId, planId, run, session } = await runner();
      const saturday = await createSession(userId, planId, { date: "2026-10-17" });
      const { sessionId } = await coachChangeTarget(userId, run.id, NOW);
      expect(sessionId).toBe(session!.id);
      await db.update(planSession).set(change).where(eq(planSession.id, session!.id));

      const { result } = await apply(userId, run.id, { kind: "scale", factor: 0.8 }, { sessionId });

      expect(result).toEqual({
        outcome: "rejected",
        reason: "no_session",
        planChange: null,
        changed: false,
      });
      expect(await storedSession(saturday.id)).toEqual(saturday);
      expect(await storedAdjustments(userId)).toEqual([
        expect.objectContaining({
          planSessionId: null,
          outcome: "rejected",
          reason: "no_session",
          requested: { kind: "scale", factor: 0.8 },
          before: null,
        }),
      ]);
    },
  );

  it("rejects as no_session when the prompt saw no session and one is there by the time the change lands", async () => {
    const { userId, run, session } = await runner();

    const { result } = await apply(userId, run.id, { kind: "rest" }, { sessionId: null });

    expect(result).toMatchObject({ outcome: "rejected", reason: "no_session", changed: false });
    expect(await storedSession(session!.id)).toEqual(session);
  });

  it("rejects a change without its own next step as invalid, logs it and changes nothing", async () => {
    const { userId, run, session } = await runner();

    const { result } = await apply(userId, run.id, { kind: "rest" }, { nextStep: null });

    expect(result).toMatchObject({ outcome: "rejected", reason: "invalid", changed: false });
    expect(await storedSession(session!.id)).toEqual(session);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        planSessionId: session!.id,
        outcome: "rejected",
        reason: "invalid",
        requested: { kind: "rest" },
        applied: null,
      }),
    ]);
  });
});

describe("applyCoachChange after a break", () => {
  /**
   * A runner back from a 14-day break on Wednesday, whose plan started this Monday, so week 1 has no
   * weekly cap and only the re-entry stops a rise: Thursday's easy 12 km eased to 6 km by "I'm back"
   * this morning, then this morning's run reviewed.
   */
  async function eased() {
    const userId = await createUser();
    await createRunOn(userId, "2026-09-30");
    const active = await createPlan(userId, {
      createdAt: new Date("2026-09-01T00:00:00Z"),
      startDate: "2026-10-12",
    });
    const thursday = await createSession(userId, active.id, {
      date: THURSDAY,
      steps: [{ kind: "run", zone: "easy", distanceM: 12_000, durationS: null }],
    });
    await createPause(userId, { startedOn: "2026-10-01", reason: "break" });
    const { reEntry } = await endPause(userId, new Date("2026-10-14T06:00:00Z"));
    expect(reEntry).toMatchObject({ daysOff: 14, factor: 0.5 });
    const run = await createRunOn(userId, TODAY);
    const session = await storedSession(thursday.id);
    expect(session.target.distanceM).toBe(6000);
    return { userId, run, session };
  }

  it("changes nothing for a rise of a session a 14-day pause eased: it may only shrink (training pause)", async () => {
    const { userId, run, session } = await eased();

    const { result } = await apply(userId, run.id, { kind: "scale", factor: 1.1 });

    expect(result).toMatchObject({ outcome: "rejected", reason: "no_change", changed: false });
    expect(await storedSession(session.id)).toEqual(session);
  });

  it("still applies a cut to a session a 14-day pause eased (training pause)", async () => {
    const { userId, run, session } = await eased();

    const { result } = await apply(userId, run.id, { kind: "scale", factor: 0.8 });

    expect(result).toMatchObject({ outcome: "applied", changed: true });
    expect((await storedSession(session.id)).target.distanceM).toBe(4800);
  });

  it("allows no rise after a week whose sessions were all missed (missed sessions)", async () => {
    const { userId, planId, run, session } = await runner({}, { distanceM: 10_000 });
    await createSession(userId, planId, { date: "2026-10-06", status: "missed" });
    await createSession(userId, planId, { date: "2026-10-08", status: "missed" });

    const { result } = await apply(userId, run.id, { kind: "scale", factor: 1.1 });

    expect(result).toMatchObject({ outcome: "rejected", reason: "no_change" });
    expect(await storedSession(session!.id)).toEqual(session);
  });

  it("clamps a rise to 10% over the week before, its missed sessions left out (missed sessions, clamped delta)", async () => {
    const { userId, planId, run, session } = await runner({}, { distanceM: 10_000 });
    await createSession(userId, planId, { date: "2026-10-06", status: "done" });
    await createSession(userId, planId, { date: "2026-10-08", status: "missed" });
    await createSession(userId, planId, {
      date: "2026-10-12",
      status: "done",
      target: { ...session!.target, distanceM: 400 },
    });

    const { result } = await apply(userId, run.id, { kind: "scale", factor: 1.1 });

    // The week before planned 8 km that count: this week may reach 8.8 km, Monday's 0.4 km included.
    expect(result.outcome).toBe("clamped");
    expect((await storedSession(session!.id)).target.distanceM).toBeCloseTo(8400, -2);
  });
});

describe("planChangesFor", () => {
  it("maps each card to the change it applied or clamped, and leaves rejected proposals and other sources out", async () => {
    const { userId, run, session } = await runner();
    const applied = await apply(userId, run.id, { kind: "scale", factor: 0.8 });
    const otherRun = await createRunOn(userId, "2026-10-10");
    const rejectedCard = await coachCard(userId, otherRun.id);
    await createAdjustment(userId, session, {
      activityId: otherRun.id,
      coachMessageId: rejectedCard,
      outcome: "rejected",
      reason: "adjusted",
      applied: null,
      after: null,
    });

    const changes = await planChangesFor([applied.coachMessageId, rejectedCard, randomUUID()]);

    expect([...changes.keys()]).toEqual([applied.coachMessageId]);
    expect(changes.get(applied.coachMessageId)).toEqual(applied.result.planChange);
    expect(await planChangesFor([])).toEqual(new Map());
  });
});
