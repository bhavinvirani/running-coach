import {
  planGenerationInputSchema,
  planPacesSchema,
  planWarningSchema,
  sessionStepsSchema,
  sessionTargetSchema,
  vdotSourceSchema,
} from "@running-coach/shared";
import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import {
  activity,
  coachMessage,
  goal,
  type NewGoalRow,
  type NewPlanRow,
  type NewPlanSessionRow,
  plan,
  planSession,
  user,
} from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { createRun, createUser } from "../seed";

// 0011_create_goal_and_plan: the runner's one goal, every plan version made from it with what generated it,
// and each plan's sessions; coach_message gains a nullable plan_id. Expand only. The runner is in
// migrate.test.ts. Fixtures are parsed with the shared schemas so they cannot drift from the contracts.

const recentTime = { distanceKey: "10k", timeS: 2700 } as const;

const inputs = planGenerationInputSchema.parse({
  goal: {
    kind: "race",
    distanceKey: "half",
    raceDate: "2027-01-17",
    targetTimeS: 6300,
    daysPerWeek: 4,
    longRunDay: "sun",
    recentTime,
  },
  startDate: "2026-10-05",
  baseline: {
    weeklyVolumesM: [30_000, 32_000, 28_000, 34_000],
    longestRunM: 18_000,
    daysSinceLastRun: 5,
  },
  vdotSource: { origin: "entered", distanceM: 10_000, timeS: 2700, activityId: null, date: null },
});

const vdotSource = vdotSourceSchema.parse(inputs.vdotSource);

const paces = planPacesSchema.parse({
  easy: { fastSPerKm: 300, slowSPerKm: 336 },
  marathon: { fastSPerKm: 262, slowSPerKm: 268 },
  threshold: { fastSPerKm: 247, slowSPerKm: 253 },
  interval: { fastSPerKm: 227, slowSPerKm: 231 },
  repetition: { fastSPerKm: 211, slowSPerKm: 215 },
  race: { fastSPerKm: 256, slowSPerKm: 260 },
});

const warnings = [
  planWarningSchema.parse({
    code: "target_time_ambitious",
    targetTimeS: 6300,
    predictedTimeS: 5960,
  }),
];

const intervalSteps = sessionStepsSchema.parse([
  { kind: "warmup", zone: "easy", distanceM: 2000, durationS: null },
  {
    repeat: 5,
    steps: [
      { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
      { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
    ],
  },
  { kind: "cooldown", zone: "easy", distanceM: 2000, durationS: null },
]);
const intervalTarget = sessionTargetSchema.parse({
  distanceM: 9500,
  durationS: 2980,
  zone: "interval",
});
const easySteps = sessionStepsSchema.parse([
  { kind: "run", zone: "easy", distanceM: 6000, durationS: null },
]);
const easyTarget = sessionTargetSchema.parse({ distanceM: 6000, durationS: 1900, zone: "easy" });

async function insertGoal(userId: string, values: Partial<NewGoalRow> = {}) {
  const [row] = await db
    .insert(goal)
    .values({
      userId,
      kind: "race",
      distanceKey: "half",
      raceDate: "2027-01-17",
      targetTimeS: 6300,
      daysPerWeek: 4,
      longRunDay: "sun",
      recentDistanceKey: recentTime.distanceKey,
      recentTimeS: recentTime.timeS,
      ...values,
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

function planValues(userId: string, goalId: string, values: Partial<NewPlanRow> = {}): NewPlanRow {
  return {
    userId,
    goalId,
    version: 1,
    engineVersion: "1",
    status: "active",
    startDate: "2026-10-05",
    endDate: "2027-01-17",
    vdot: 47.62,
    vdotSource,
    paces,
    inputs,
    warnings,
    ...values,
  };
}

async function insertPlan(userId: string, goalId: string, values: Partial<NewPlanRow> = {}) {
  const [row] = await db
    .insert(plan)
    .values(planValues(userId, goalId, values))
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

function sessionValues(
  userId: string,
  planId: string,
  values: Partial<NewPlanSessionRow> = {},
): NewPlanSessionRow {
  return {
    userId,
    planId,
    date: "2026-10-06",
    type: "easy",
    phase: "base",
    target: easyTarget,
    steps: easySteps,
    ...values,
  };
}

async function sessionsOf(planId: string) {
  return db
    .select()
    .from(planSession)
    .where(eq(planSession.planId, planId))
    .orderBy(asc(planSession.date));
}

async function indexesOf(table: string): Promise<string[]> {
  const result = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where tablename = ${table} order by indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

describe("goal, plan and plan_session", () => {
  it("are created with the one-goal, one-active-plan and session-by-date indexes", async () => {
    expect(await indexesOf("goal")).toEqual(["goal_pkey", "goal_user_id_unique"]);
    expect(await indexesOf("plan")).toEqual([
      "plan_goal_id_version_unique",
      "plan_pkey",
      "plan_user_id_active_idx",
      "plan_user_id_idx",
    ]);
    expect(await indexesOf("plan_session")).toEqual([
      "plan_session_activity_id_idx",
      "plan_session_pkey",
      "plan_session_plan_id_date_idx",
      "plan_session_user_id_idx",
    ]);
  });

  it("stores a goal, its plan with what generated it, and sessions that start planned and unlinked", async () => {
    const userId = await createUser();
    const stored = await insertGoal(userId);
    const created = await insertPlan(userId, stored.id);
    await db.insert(planSession).values([
      sessionValues(userId, created.id, {
        date: "2026-10-08",
        type: "intervals",
        target: intervalTarget,
        steps: intervalSteps,
      }),
      sessionValues(userId, created.id),
    ]);

    expect(stored).toMatchObject({
      kind: "race",
      distanceKey: "half",
      raceDate: "2027-01-17",
      targetTimeS: 6300,
      daysPerWeek: 4,
      longRunDay: "sun",
      recentDistanceKey: "10k",
      recentTimeS: 2700,
    });
    const [read] = await db.select().from(plan).where(eq(plan.id, created.id));
    expect(read).toMatchObject({
      version: 1,
      status: "active",
      startDate: "2026-10-05",
      endDate: "2027-01-17",
      vdot: 47.62,
      vdotSource,
      paces,
      inputs,
      warnings,
    });
    expect(await sessionsOf(created.id)).toMatchObject([
      { date: "2026-10-06", type: "easy", phase: "base", target: easyTarget, steps: easySteps },
      {
        date: "2026-10-08",
        type: "intervals",
        target: intervalTarget,
        steps: intervalSteps,
        status: "planned",
        activityId: null,
        garminWorkoutId: null,
        garminScheduleId: null,
      },
    ]);
  });

  it("stores a fitness goal with no distance, race date, target or entered time", async () => {
    const userId = await createUser();

    const stored = await insertGoal(userId, {
      kind: "fitness",
      distanceKey: null,
      raceDate: null,
      targetTimeS: null,
      recentDistanceKey: null,
      recentTimeS: null,
    });

    expect(stored).toMatchObject({ distanceKey: null, raceDate: null, recentTimeS: null });
  });

  it("keeps one goal per user", async () => {
    const userId = await createUser();
    await insertGoal(userId);

    expect(await postgresErrorCode(insertGoal(userId))).toBe("23505");
    expect(await insertGoal(await createUser("other@example.com"))).toBeDefined();
  });

  it("keeps one active plan per user and one row per goal version, while superseded versions stay", async () => {
    const userId = await createUser();
    const { id: goalId } = await insertGoal(userId);
    const first = await insertPlan(userId, goalId);

    expect(await postgresErrorCode(insertPlan(userId, goalId, { version: 2 }))).toBe("23505");
    expect(await postgresErrorCode(insertPlan(userId, goalId, { status: "superseded" }))).toBe(
      "23505",
    );

    await db.update(plan).set({ status: "superseded" }).where(eq(plan.id, first.id));
    await insertPlan(userId, goalId, { version: 2 });
    await insertPlan(userId, goalId, { version: 3, status: "superseded" });
    const otherUser = await createUser("other@example.com");
    await insertPlan(otherUser, (await insertGoal(otherUser)).id);

    const versions = await db
      .select({ version: plan.version, status: plan.status })
      .from(plan)
      .where(eq(plan.userId, userId))
      .orderBy(asc(plan.version));
    expect(versions).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "active" },
      { version: 3, status: "superseded" },
    ]);
  });

  it("rejects a session type, session status, phase, plan status or goal value outside the shared lists", async () => {
    const userId = await createUser();
    const { id: goalId } = await insertGoal(userId);
    const { id: planId } = await insertPlan(userId, goalId);
    const session = (values: Record<string, string>) =>
      db.insert(planSession).values(sessionValues(userId, planId, values));

    expect(await postgresErrorCode(session({ type: "fartlek" }))).toBe("23514");
    expect(await postgresErrorCode(session({ status: "skipped" }))).toBe("23514");
    expect(await postgresErrorCode(session({ phase: "recovery" }))).toBe("23514");
    expect(
      await postgresErrorCode(
        db
          .update(plan)
          .set({ status: "draft" as never })
          .where(eq(plan.id, planId)),
      ),
    ).toBe("23514");
    for (const values of [
      { kind: "ultra" },
      { distanceKey: "1mi" },
      { longRunDay: "sunday" },
      { recentDistanceKey: "3k" },
    ]) {
      expect(
        await postgresErrorCode(
          db
            .update(goal)
            .set(values as never)
            .where(eq(goal.id, goalId)),
        ),
      ).toBe("23514");
    }
  });

  it("rejects an entered recent time with only its distance or only its time", async () => {
    const userId = await createUser();
    const { id: goalId } = await insertGoal(userId);

    expect(
      await postgresErrorCode(
        db.update(goal).set({ recentTimeS: null }).where(eq(goal.id, goalId)),
      ),
    ).toBe("23514");
    expect(
      await postgresErrorCode(
        db.update(goal).set({ recentDistanceKey: null }).where(eq(goal.id, goalId)),
      ),
    ).toBe("23514");
  });

  it("unlinks a session from its run when the run is deleted, and keeps the session", async () => {
    const userId = await createUser();
    const run = await createRun(userId);
    const { id: planId } = await insertPlan(userId, (await insertGoal(userId)).id);
    await db
      .insert(planSession)
      .values(sessionValues(userId, planId, { status: "done", activityId: run.id }));

    await db.delete(activity).where(eq(activity.id, run.id));

    expect(await sessionsOf(planId)).toMatchObject([{ status: "done", activityId: null }]);
  });

  it("deletes plans and their sessions with their goal, and everything with the user", async () => {
    const userId = await createUser();
    const { id: goalId } = await insertGoal(userId);
    const old = await insertPlan(userId, goalId, { status: "superseded" });
    const current = await insertPlan(userId, goalId, { version: 2 });
    for (const planId of [old.id, current.id]) {
      await db.insert(planSession).values(sessionValues(userId, planId));
    }

    await db.delete(plan).where(eq(plan.id, old.id));
    expect(await sessionsOf(old.id)).toEqual([]);
    expect(await sessionsOf(current.id)).toHaveLength(1);

    await db.delete(goal).where(eq(goal.id, goalId));
    expect(await db.select().from(plan)).toEqual([]);
    expect(await db.select().from(planSession)).toEqual([]);

    const plannedAgain = await insertGoal(userId);
    await db
      .insert(planSession)
      .values(sessionValues(userId, (await insertPlan(userId, plannedAgain.id)).id));
    await db.delete(user).where(eq(user.id, userId));
    expect(await db.select().from(goal)).toEqual([]);
    expect(await db.select().from(plan)).toEqual([]);
    expect(await db.select().from(planSession)).toEqual([]);
  });
});

describe("coach_message.plan_id", () => {
  it("is a nullable uuid without a default, so messages stored before it read null", async () => {
    const result = await db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      sql`select data_type, is_nullable, column_default from information_schema.columns
          where table_name = 'coach_message' and column_name = 'plan_id'`,
    );
    expect(result.rows).toEqual([{ data_type: "uuid", is_nullable: "YES", column_default: null }]);
    const userId = await createUser();
    const run = await createRun(userId);

    const [row] = await db
      .insert(coachMessage)
      .values({
        userId,
        kind: "insight",
        activityId: run.id,
        promptVersion: "run-insight/v1",
        content: { headline: "10.0 km in 50:00." },
      })
      .returning();

    expect(row).toMatchObject({ kind: "insight", activityId: run.id, planId: null });
  });

  it("links a message to its plan and keeps the message, unlinked, when the plan goes", async () => {
    const userId = await createUser();
    const { id: planId } = await insertPlan(userId, (await insertGoal(userId)).id);
    const [{ id: messageId } = { id: "" }] = await db
      .insert(coachMessage)
      .values({
        userId,
        kind: "weekly_review",
        planId,
        promptVersion: "weekly-review/v1",
        content: { headline: "Week 1: 4 of 4 runs." },
      })
      .returning({ id: coachMessage.id });

    await db.delete(plan).where(eq(plan.id, planId));

    const [kept] = await db.select().from(coachMessage).where(eq(coachMessage.id, messageId));
    expect(kept).toMatchObject({ kind: "weekly_review", planId: null });
  });
});
