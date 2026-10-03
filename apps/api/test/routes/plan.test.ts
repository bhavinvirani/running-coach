import type { GoalInput } from "@running-coach/shared";
import { planResponseSchema, saveGoalResponseSchema } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { planSession } from "../../src/db/schema";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { createSession } from "../seed";

// GET /api/plan on the real Postgres, with the clock pinned (Date only, timers run) so the plan saved
// through PUT /api/goal (test/routes/goal.test.ts) starts on a fixed Monday.

const app = createTestApp();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

type Agent = Awaited<ReturnType<typeof signedInAgent>>;

const tenK: GoalInput = {
  kind: "race",
  distanceKey: "10k",
  raceDate: "2027-01-24",
  targetTimeS: null,
  daysPerWeek: 4,
  longRunDay: "sun",
  recentTime: { distanceKey: "5k", timeS: 1500 },
};

async function saveGoal(agent: Agent, body: GoalInput) {
  const response = await agent.put("/api/goal").send(body);
  expect(response.status).toBe(200);
  const result = saveGoalResponseSchema.parse(response.body);
  if (!result.ok) throw new Error(`Expected a plan, got the conflict ${result.conflict.code}`);
  return result;
}

async function getPlan(agent: Agent) {
  const response = await agent.get("/api/plan");
  expect(response.status).toBe(200);
  return planResponseSchema.parse(response.body);
}

describe("GET /api/plan", () => {
  it("returns no goal and no plan before a goal is saved", async () => {
    const agent = await signedInAgent(app);

    expect(await getPlan(agent)).toEqual({ goal: null, plan: null });
  });

  it("returns the goal and its active plan, not the version it superseded (regenerating a plan)", async () => {
    const agent = await signedInAgent(app);
    const first = await saveGoal(agent, tenK);
    const second = await saveGoal(agent, { ...tenK, raceDate: "2027-01-31" });

    const body = await getPlan(agent);

    expect(body).toEqual({ goal: second.goal, plan: second.plan });
    expect(body.plan).toMatchObject({ version: 2, status: "active", goalId: first.goal.id });
  });

  it("lists the runner's custom workouts in their weeks and the plan's skipped sessions, summing only what is not skipped (custom session, skipped session)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const { plan: saved } = await saveGoal(agent, tenK);
    const [weekOne] = saved.weeks;
    const [first, second] = weekOne!.sessions;
    await db.update(planSession).set({ status: "skipped" }).where(eq(planSession.id, first!.id));
    const custom = await createSession(userId, null, { date: first!.date, title: "Strides" });
    await createSession(userId, null, { date: second!.date, status: "skipped" });
    // Before the plan's first Monday and after its race week: in no week.
    await createSession(userId, null, { date: "2026-10-04" });
    await createSession(userId, null, { date: "2027-02-01" });

    const shown = (await getPlan(agent)).plan!;

    const week = shown.weeks[0]!;
    expect(week.sessions.map((s) => [s.id, s.status, s.source])).toEqual([
      [first!.id, "skipped", "plan"],
      [custom.id, "planned", "custom"],
      ...weekOne!.sessions.slice(1).map((s) => [s.id, "planned", "plan"]),
    ]);
    expect(week.sessions[1]).toMatchObject({ title: "Strides", onGarmin: false });
    expect(week.distanceM).toBe(
      weekOne!.distanceM - first!.target.distanceM + custom.target.distanceM,
    );
    expect(shown.weeks.flatMap((w) => w.sessions)).toHaveLength(
      saved.weeks.flatMap((w) => w.sessions).length + 1,
    );
  });

  it("returns 401 problem+json without a session", async () => {
    expectProblem(await request(app).get("/api/plan"), 401, "unauthorized");
  });
});
