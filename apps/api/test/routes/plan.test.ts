import type { GoalInput } from "@running-coach/shared";
import { planResponseSchema, saveGoalResponseSchema } from "@running-coach/shared";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, expectProblem, signedInAgent } from "../helpers";

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

  it("returns 401 problem+json without a session", async () => {
    expectProblem(await request(app).get("/api/plan"), 401, "unauthorized");
  });
});
