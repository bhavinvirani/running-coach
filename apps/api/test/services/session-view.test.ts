import {
  calendarResponseSchema,
  type PlanSession,
  planResponseSchema,
  sessionDetailResponseSchema,
} from "@running-coach/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "../../src/db/client";
import { startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { createTestApp, ownerId, signedInAgent } from "../helpers";
import { createPlan, createRunOn, createSession, TEMPO_STEPS } from "../seed";
import { adjustedSession, createAdjustment, createPause } from "../seed-adaptation";
import { createReview } from "../seed-weekly-review";

// What every session response carries from slice 9's adaptation, through the three readers (GET /api/plan,
// /api/calendar, /api/sessions/:id) on the real Postgres: its latest change from plan_adjustment, and
// whether the open pause holds it.

const app = createTestApp();

// The calendar and the session screen read whether a push is queued.
beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Agent = Awaited<ReturnType<typeof signedInAgent>>;

async function owner() {
  const agent = await signedInAgent(app);
  const userId = await ownerId();
  const active = await createPlan(userId);
  return { agent, userId, planId: active.id };
}

async function planSessions(agent: Agent): Promise<PlanSession[]> {
  const { plan } = planResponseSchema.parse((await agent.get("/api/plan")).body);
  return plan!.weeks.flatMap((week) => week.sessions);
}

async function calendarSessions(agent: Agent, from: string, to: string): Promise<PlanSession[]> {
  const response = await agent.get("/api/calendar").query({ from, to });
  return calendarResponseSchema.parse(response.body).days.flatMap((day) => day.sessions);
}

async function sessionDetail(agent: Agent, id: string): Promise<PlanSession> {
  const response = await agent.get(`/api/sessions/${id}`);
  return sessionDetailResponseSchema.parse(response.body).session;
}

function byId(sessions: PlanSession[], id: string): PlanSession {
  const found = sessions.find((session) => session.id === id);
  if (!found) throw new Error(`no session ${id} in the response`);
  return found;
}

describe("session adjustment", () => {
  it("is the latest applied change from any source, with the session as the plan had it before the first", async () => {
    const { agent, userId, planId } = await owner();
    const tempo = await createSession(userId, planId, {
      date: "2026-10-15",
      type: "tempo",
      steps: TEMPO_STEPS,
    });
    const untouched = await createSession(userId, planId, { date: "2026-10-17" });
    const gapRun = await createRunOn(userId, "2026-10-12");
    const reviewed = await createRunOn(userId, "2026-10-13");
    const original = adjustedSession(tempo);
    const eased = {
      ...original,
      type: "easy" as const,
      target: { ...original.target, distanceM: 6000 },
    };
    await createAdjustment(userId, tempo, {
      source: "gap",
      kind: "re_entry",
      activityId: gapRun.id,
      before: original,
      after: eased,
      createdAt: new Date("2026-10-12T09:00:00Z"),
    });
    await createAdjustment(userId, tempo, {
      source: "coach",
      kind: "scale",
      activityId: reviewed.id,
      before: eased,
      after: { ...eased, target: { ...eased.target, distanceM: 4800 } },
      createdAt: new Date("2026-10-13T09:00:00Z"),
    });

    const sessions = await planSessions(agent);

    expect(byId(sessions, tempo.id).adjustment).toEqual({
      source: "coach",
      kind: "scale",
      activityId: reviewed.id,
      original: {
        type: "tempo",
        title: null,
        status: "planned",
        target: tempo.target,
      },
      at: "2026-10-13T09:00:00.000Z",
    });
    expect(byId(sessions, untouched.id).adjustment).toBeNull();
  });

  it("leaves out a coach proposal the engine rejected: it changed nothing (rejected delta)", async () => {
    const { agent, userId, planId } = await owner();
    const race = await createSession(userId, planId, { date: "2026-10-18", type: "race" });
    const run = await createRunOn(userId, "2026-10-13");
    await createAdjustment(userId, race, {
      outcome: "rejected",
      reason: "race",
      activityId: run.id,
      applied: null,
      after: null,
    });

    expect(byId(await planSessions(agent), race.id).adjustment).toBeNull();
  });

  it("reads a pause's change with no run behind it", async () => {
    const { agent, userId, planId } = await owner();
    const session = await createSession(userId, planId, { date: "2026-10-15", status: "skipped" });
    const pause = await createPause(userId, { startedOn: "2026-10-12", endedOn: "2026-10-16" });
    await createAdjustment(userId, session, {
      source: "pause",
      kind: "rest",
      pauseId: pause.id,
      requested: { kind: "rest" },
      applied: { kind: "rest" },
      before: { ...adjustedSession(session), status: "planned" },
    });

    const detail = await sessionDetail(agent, session.id);

    expect(detail.adjustment).toMatchObject({
      source: "pause",
      kind: "rest",
      activityId: null,
      original: { status: "planned" },
    });
  });

  it("reads a weekly review's change like a coach change, with no run behind it", async () => {
    const { agent, userId, planId } = await owner();
    const session = await createSession(userId, planId, { date: "2026-10-13" });
    const review = await createReview(userId, { weekStart: "2026-10-05" });
    const before = adjustedSession(session);
    await createAdjustment(userId, session, {
      source: "review",
      outcome: "clamped",
      coachMessageId: review.id,
      before,
      after: { ...before, target: { ...before.target, distanceM: 8300 } },
    });

    const detail = await sessionDetail(agent, session.id);

    expect(detail.adjustment).toMatchObject({
      source: "review",
      kind: "scale",
      activityId: null,
      original: { type: "easy", status: "planned", target: session.target },
    });
  });

  it("is the same on GET /api/plan, /api/calendar and /api/sessions/:id", async () => {
    const { agent, userId, planId } = await owner();
    const session = await createSession(userId, planId, { date: "2026-10-15" });
    const run = await createRunOn(userId, "2026-10-13");
    await createAdjustment(userId, session, { activityId: run.id });

    const fromPlan = byId(await planSessions(agent), session.id);
    const fromCalendar = byId(
      await calendarSessions(agent, "2026-10-12", "2026-10-18"),
      session.id,
    );
    const fromDetail = await sessionDetail(agent, session.id);

    expect(fromPlan.adjustment).not.toBeNull();
    expect(fromCalendar).toEqual(fromPlan);
    expect(fromDetail).toEqual(fromPlan);
  });

  it("is read for every session of a plan in one query, whatever their number (no N+1)", async () => {
    const { agent, userId, planId } = await owner();
    for (const date of ["2026-10-13", "2026-10-15", "2026-10-17", "2026-10-20", "2026-10-22"]) {
      const session = await createSession(userId, planId, { date });
      await createAdjustment(userId, session, { source: "gap", kind: "re_entry" });
    }
    const query = vi.spyOn(pool, "query");

    const sessions = await planSessions(agent);

    expect(sessions.filter((session) => session.adjustment !== null)).toHaveLength(5);
    const adjustmentReads = query.mock.calls.filter(([config]) =>
      JSON.stringify(config).includes('from \\"plan_adjustment\\"'),
    );
    expect(adjustmentReads).toHaveLength(1);
  });
});

describe("session paused", () => {
  it("holds planned and moved sessions from the open pause's start on, custom ones too, and not done, skipped or earlier ones (illness or injury pause)", async () => {
    const { agent, userId, planId } = await owner();
    const before = await createSession(userId, planId, { date: "2026-10-11" });
    const first = await createSession(userId, planId, { date: "2026-10-12" });
    const moved = await createSession(userId, planId, { date: "2026-10-14", status: "moved" });
    const done = await createSession(userId, planId, { date: "2026-10-13", status: "done" });
    const skipped = await createSession(userId, planId, { date: "2026-10-15", status: "skipped" });
    const custom = await createSession(userId, null, { date: "2026-10-16", title: "Strides" });
    await createPause(userId, { startedOn: "2026-10-12" });

    const sessions = await calendarSessions(agent, "2026-10-11", "2026-10-18");
    const paused = (id: string) => sessions.find((session) => session.id === id)?.paused;

    expect(paused(before.id)).toBe(false);
    expect(paused(first.id)).toBe(true);
    expect(paused(moved.id)).toBe(true);
    expect(paused(done.id)).toBe(false);
    // Skipped plan sessions are listed; skipped custom ones are not.
    expect(paused(skipped.id)).toBe(false);
    expect(paused(custom.id)).toBe(true);
    expect((await sessionDetail(agent, first.id)).paused).toBe(true);
    expect(byId(await planSessions(agent), moved.id).paused).toBe(true);
  });

  it("holds nothing once the pause has ended", async () => {
    const { agent, userId, planId } = await owner();
    const session = await createSession(userId, planId, { date: "2026-10-14" });
    await createPause(userId, { startedOn: "2026-10-12", endedOn: "2026-10-13" });

    expect((await sessionDetail(agent, session.id)).paused).toBe(false);
  });
});
