import type { AdjustedSession } from "@running-coach/engine";
import { planDeltaSchema, sessionSnapshotSchema, sessionStepsSchema } from "@running-coach/shared";
import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import {
  activity,
  coachMessage,
  type NewPlanAdjustmentRow,
  type NewTrainingPauseRow,
  planAdjustment,
  planSession,
  trainingPause,
  user,
} from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { createPlan, createRunOn, createSession, createUser, TEMPO_STEPS } from "../seed";

// 0016_add_adaptation: training_pause holds the runner's pauses, at most one open; plan_adjustment logs every
// change made to a session after its plan was made, and every coach proposal the engine rejected, with
// unique indexes that make each writer idempotent. Expand only: two new tables. The runner is in
// migrate.test.ts. Fixtures are parsed with the shared schemas so they cannot drift from the contracts.

const tempoBefore: AdjustedSession = {
  ...sessionSnapshotSchema.parse({
    type: "tempo",
    title: null,
    status: "planned",
    target: { distanceM: 8000, durationS: 2400, zone: "threshold" },
  }),
  steps: TEMPO_STEPS,
};
const easyAfter: AdjustedSession = {
  ...sessionSnapshotSchema.parse({
    type: "easy",
    title: null,
    status: "planned",
    target: { distanceM: 7200, durationS: 2400, zone: "easy" },
  }),
  steps: sessionStepsSchema.parse([
    { kind: "run", zone: "easy", distanceM: null, durationS: 2400 },
  ]),
};

async function insertPause(userId: string, values: Partial<NewTrainingPauseRow> = {}) {
  const [row] = await db
    .insert(trainingPause)
    .values({ userId, reason: "sick", startedOn: "2026-10-01", ...values })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

function adjustmentValues(
  userId: string,
  values: Partial<NewPlanAdjustmentRow> = {},
): NewPlanAdjustmentRow {
  return { userId, source: "coach", kind: "scale", outcome: "applied", ...values };
}

async function insertAdjustment(userId: string, values: Partial<NewPlanAdjustmentRow> = {}) {
  const [row] = await db
    .insert(planAdjustment)
    .values(adjustmentValues(userId, values))
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

async function insertInsight(userId: string, activityId: string) {
  const [row] = await db
    .insert(coachMessage)
    .values({
      userId,
      kind: "insight",
      activityId,
      promptVersion: "run-insight/v2",
      content: { headline: "10.0 km in 50:00." },
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/** A user with an active plan and two sessions after its runs: the next tempo and the long run. */
async function runner(email?: string) {
  const userId = await createUser(email);
  const { id: planId } = await createPlan(userId);
  const tempo = await createSession(userId, planId, {
    date: "2026-10-08",
    type: "tempo",
    steps: TEMPO_STEPS,
  });
  const long = await createSession(userId, planId, { date: "2026-10-11", type: "long" });
  return { userId, planId, tempo, long };
}

async function indexesOf(table: string): Promise<string[]> {
  const result = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where tablename = ${table} order by indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

async function adjustmentsOf(userId: string) {
  return db
    .select()
    .from(planAdjustment)
    .where(eq(planAdjustment.userId, userId))
    .orderBy(asc(planAdjustment.createdAt));
}

describe("0016 indexes", () => {
  it("creates both tables with the open-pause, lookup and idempotency indexes", async () => {
    expect(await indexesOf("training_pause")).toEqual([
      "training_pause_pkey",
      "training_pause_user_id_idx",
      "training_pause_user_id_open_idx",
    ]);
    expect(await indexesOf("plan_adjustment")).toEqual([
      "plan_adjustment_activity_id_idx",
      "plan_adjustment_coach_activity_id_idx",
      "plan_adjustment_coach_message_id_idx",
      "plan_adjustment_gap_activity_id_session_idx",
      "plan_adjustment_pause_id_idx",
      "plan_adjustment_pause_id_session_idx",
      "plan_adjustment_pkey",
      "plan_adjustment_plan_session_id_idx",
      "plan_adjustment_user_id_idx",
    ]);
  });
});

describe("training_pause", () => {
  it("stores an open pause with its reason and local start date, and reads it as the open one", async () => {
    const userId = await createUser();
    await insertPause(userId, {
      reason: "injured",
      startedOn: "2026-09-20",
      endedOn: "2026-09-24",
    });

    const created = await insertPause(userId, { reason: "injured", startedOn: "2026-10-05" });

    expect(created).toMatchObject({ reason: "injured", startedOn: "2026-10-05", endedOn: null });
    const open = await db
      .select({ id: trainingPause.id })
      .from(trainingPause)
      .where(sql`${trainingPause.userId} = ${userId} and ${trainingPause.endedOn} is null`);
    expect(open).toEqual([{ id: created.id }]);
  });

  it("keeps one open pause per user (a double tap on Sick opens one), while ended pauses stay", async () => {
    const userId = await createUser();
    const first = await insertPause(userId);

    expect(await postgresErrorCode(insertPause(userId, { reason: "break" }))).toBe("23505");

    await db
      .update(trainingPause)
      .set({ endedOn: "2026-10-04" })
      .where(eq(trainingPause.id, first.id));
    await insertPause(userId, { reason: "break", startedOn: "2026-10-06" });
    await insertPause(await createUser("other@example.com"));
    expect(
      await db.select().from(trainingPause).where(eq(trainingPause.userId, userId)),
    ).toHaveLength(2);
  });

  it("rejects an end before the start, and takes a pause that ends the day it starts", async () => {
    const userId = await createUser();
    const pause = await insertPause(userId, { startedOn: "2026-10-05" });
    const end = (endedOn: string) =>
      db.update(trainingPause).set({ endedOn }).where(eq(trainingPause.id, pause.id)).returning();

    expect(await postgresErrorCode(end("2026-10-04"))).toBe("23514");
    expect(await end("2026-10-05")).toMatchObject([{ endedOn: "2026-10-05" }]);
  });

  it("rejects a reason outside the shared list", async () => {
    const userId = await createUser();

    expect(await postgresErrorCode(insertPause(userId, { reason: "tired" as never }))).toBe(
      "23514",
    );
  });
});

describe("plan_adjustment", () => {
  it("stores a clamped coach change with the delta as proposed and applied, the session before and after, its run and insight", async () => {
    const { userId, tempo } = await runner();
    const run = await createRunOn(userId, "2026-10-06");
    const insight = await insertInsight(userId, run.id);
    const requested = planDeltaSchema.parse({ kind: "scale", factor: 1.3 });
    const applied = planDeltaSchema.parse({ kind: "scale", factor: 1.1 });

    await insertAdjustment(userId, {
      planSessionId: tempo.id,
      outcome: "clamped",
      requested,
      applied,
      before: tempoBefore,
      after: easyAfter,
      activityId: run.id,
      coachMessageId: insight.id,
    });

    expect(await adjustmentsOf(userId)).toMatchObject([
      {
        planSessionId: tempo.id,
        source: "coach",
        kind: "scale",
        outcome: "clamped",
        reason: null,
        requested,
        applied,
        before: tempoBefore,
        after: easyAfter,
        activityId: run.id,
        coachMessageId: insight.id,
        pauseId: null,
      },
    ]);
  });

  it("stores a rejected coach proposal with its reason and no session (no_session)", async () => {
    const userId = await createUser();
    const run = await createRunOn(userId, "2026-10-06");

    const row = await insertAdjustment(userId, {
      kind: "rest",
      outcome: "rejected",
      reason: "no_session",
      requested: planDeltaSchema.parse({ kind: "rest" }),
      activityId: run.id,
    });

    expect(row).toMatchObject({
      planSessionId: null,
      reason: "no_session",
      applied: null,
      before: null,
      after: null,
    });
  });

  it("stores a pause re-entry with what was asked for (factor, walk-run, days off)", async () => {
    const { userId, tempo } = await runner();
    const pause = await insertPause(userId, { endedOn: "2026-10-10" });
    const requested = { factor: 0.7, walkRun: true, daysOff: 9 };

    const row = await insertAdjustment(userId, {
      planSessionId: tempo.id,
      source: "pause",
      kind: "re_entry",
      requested,
      applied: requested,
      before: tempoBefore,
      after: easyAfter,
      pauseId: pause.id,
    });

    expect(row).toMatchObject({ source: "pause", kind: "re_entry", requested, pauseId: pause.id });
  });

  it("rejects a source, kind, outcome or reason outside the shared lists", async () => {
    const userId = await createUser();
    const insert = (values: Record<string, string>) =>
      db.insert(planAdjustment).values(adjustmentValues(userId, values));

    expect(await postgresErrorCode(insert({ source: "runner" }))).toBe("23514");
    expect(await postgresErrorCode(insert({ kind: "none" }))).toBe("23514");
    expect(await postgresErrorCode(insert({ outcome: "pending" }))).toBe("23514");
    expect(await postgresErrorCode(insert({ outcome: "rejected", reason: "busy" }))).toBe("23514");
  });

  it("requires a reason exactly when the outcome is rejected", async () => {
    const userId = await createUser();
    const insert = (values: Partial<NewPlanAdjustmentRow>) =>
      db.insert(planAdjustment).values(adjustmentValues(userId, values));

    expect(await postgresErrorCode(insert({ outcome: "rejected" }))).toBe("23514");
    expect(await postgresErrorCode(insert({ outcome: "applied", reason: "race" }))).toBe("23514");
    expect(await postgresErrorCode(insert({ outcome: "clamped", reason: "locked" }))).toBe("23514");
    expect(
      await postgresErrorCode(insert({ outcome: "rejected", reason: "race" })),
    ).toBeUndefined();
  });

  it("keeps one coach proposal per run, rejected ones included (the insight job firing twice)", async () => {
    const { userId, tempo, long } = await runner();
    const run = await createRunOn(userId, "2026-10-06");
    const other = await createRunOn(userId, "2026-10-07");
    await insertAdjustment(userId, { planSessionId: tempo.id, activityId: run.id });

    expect(
      await postgresErrorCode(
        insertAdjustment(userId, { planSessionId: tempo.id, activityId: run.id }),
      ),
    ).toBe("23505");
    expect(
      await postgresErrorCode(
        insertAdjustment(userId, {
          planSessionId: long.id,
          activityId: run.id,
          outcome: "rejected",
          reason: "adjusted",
        }),
      ),
    ).toBe("23505");
    await insertAdjustment(userId, {
      planSessionId: tempo.id,
      activityId: other.id,
      outcome: "rejected",
      reason: "adjusted",
    });
    // The same run ending a gap is another writer.
    await insertAdjustment(userId, {
      planSessionId: tempo.id,
      activityId: run.id,
      source: "gap",
      kind: "re_entry",
    });
    expect(await adjustmentsOf(userId)).toHaveLength(3);
  });

  it("keeps one gap re-entry per session per run that ended the gap (a double sync)", async () => {
    const { userId, tempo, long } = await runner();
    const run = await createRunOn(userId, "2026-10-06");
    const later = await createRunOn(userId, "2026-10-20");
    const gap = { source: "gap", kind: "re_entry" } as const;
    await insertAdjustment(userId, { ...gap, planSessionId: tempo.id, activityId: run.id });

    expect(
      await postgresErrorCode(
        insertAdjustment(userId, { ...gap, planSessionId: tempo.id, activityId: run.id }),
      ),
    ).toBe("23505");
    await insertAdjustment(userId, { ...gap, planSessionId: long.id, activityId: run.id });
    await insertAdjustment(userId, { ...gap, planSessionId: tempo.id, activityId: later.id });
    expect(await adjustmentsOf(userId)).toHaveLength(3);
  });

  it("keeps one pause re-entry per session per pause (a double I'm back)", async () => {
    const { userId, tempo, long } = await runner();
    const first = await insertPause(userId, { startedOn: "2026-09-20", endedOn: "2026-09-24" });
    const second = await insertPause(userId, { startedOn: "2026-10-01" });
    const fromPause = { source: "pause", kind: "re_entry" } as const;
    await insertAdjustment(userId, { ...fromPause, planSessionId: tempo.id, pauseId: first.id });

    expect(
      await postgresErrorCode(
        insertAdjustment(userId, { ...fromPause, planSessionId: tempo.id, pauseId: first.id }),
      ),
    ).toBe("23505");
    await insertAdjustment(userId, { ...fromPause, planSessionId: long.id, pauseId: first.id });
    await insertAdjustment(userId, { ...fromPause, planSessionId: tempo.id, pauseId: second.id });
    expect(await adjustmentsOf(userId)).toHaveLength(3);
  });

  it("goes with its session, and keeps the log unlinked when its run, insight or pause goes", async () => {
    const { userId, planId, tempo, long } = await runner();
    const run = await createRunOn(userId, "2026-10-06");
    const other = await createRunOn(userId, "2026-10-07");
    const insight = await insertInsight(userId, other.id);
    const pause = await insertPause(userId, { endedOn: "2026-10-05" });
    const coach = await insertAdjustment(userId, { planSessionId: long.id, activityId: run.id });
    const coached = await insertAdjustment(userId, {
      planSessionId: long.id,
      activityId: other.id,
      outcome: "rejected",
      reason: "adjusted",
      coachMessageId: insight.id,
    });
    const fromPause = await insertAdjustment(userId, {
      planSessionId: long.id,
      source: "pause",
      kind: "re_entry",
      pauseId: pause.id,
    });
    await insertAdjustment(userId, { planSessionId: tempo.id, source: "gap", kind: "re_entry" });

    await db.delete(planSession).where(eq(planSession.id, tempo.id));
    expect((await adjustmentsOf(userId)).map((row) => row.id).sort()).toEqual(
      [coach.id, coached.id, fromPause.id].sort(),
    );

    // Both coach rows end up unlinked, which the one-proposal-per-run index allows.
    await db.delete(activity).where(eq(activity.id, run.id));
    await db.delete(activity).where(eq(activity.id, other.id));
    await db.delete(trainingPause).where(eq(trainingPause.id, pause.id));
    expect(await adjustmentsOf(userId)).toMatchObject([
      { id: coach.id, activityId: null, planSessionId: long.id },
      // The insight went with its run (coach_message cascades from activity).
      { id: coached.id, activityId: null, coachMessageId: null },
      { id: fromPause.id, pauseId: null },
    ]);

    await db.execute(sql`delete from plan where id = ${planId}`);
    expect(await adjustmentsOf(userId)).toEqual([]);
  });

  it("drops a deleted insight's link and keeps the change", async () => {
    const { userId, long } = await runner();
    const run = await createRunOn(userId, "2026-10-06");
    const insight = await insertInsight(userId, run.id);
    const row = await insertAdjustment(userId, {
      planSessionId: long.id,
      activityId: run.id,
      coachMessageId: insight.id,
    });

    await db.delete(coachMessage).where(eq(coachMessage.id, insight.id));

    expect(await adjustmentsOf(userId)).toMatchObject([
      { id: row.id, activityId: run.id, coachMessageId: null },
    ]);
  });

  it("goes with its user, pauses included, and leaves other users' rows", async () => {
    const { userId, long } = await runner();
    const other = await runner("other@example.com");
    for (const owner of [
      { id: userId, sessionId: long.id },
      { id: other.userId, sessionId: other.long.id },
    ]) {
      const pause = await insertPause(owner.id);
      await insertAdjustment(owner.id, {
        planSessionId: owner.sessionId,
        source: "pause",
        kind: "re_entry",
        pauseId: pause.id,
      });
    }

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select({ userId: trainingPause.userId }).from(trainingPause)).toEqual([
      { userId: other.userId },
    ]);
    expect(await db.select({ userId: planAdjustment.userId }).from(planAdjustment)).toEqual([
      { userId: other.userId },
    ]);
  });
});
