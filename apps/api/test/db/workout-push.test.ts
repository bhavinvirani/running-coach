import { errorCodeSchema, otherGarminWorkoutSchema } from "@running-coach/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { garminConnection, planSession } from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { connectGarmin, createPlan, createSession, createUser } from "../seed";

// 0012_add_workout_push: a custom workout is a plan_session without plan_id and phase, sessions can be
// skipped and carry what Garmin holds for them (garmin_date, garmin_hash), sessions are read by user and
// date, and garmin_connection keeps the push's state. Expand only: rows stored before read as they were.

async function columnsOf(table: string, names: string[]) {
  const result = await db.execute<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    sql`select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_name = ${table} and column_name in ${names} order by column_name`,
  );
  return result.rows;
}

describe("plan_session after 0012", () => {
  it("has nullable plan_id and phase, title, garmin_date and garmin_hash, and a (user_id, date) index", async () => {
    expect(
      await columnsOf("plan_session", ["plan_id", "phase", "title", "garmin_date", "garmin_hash"]),
    ).toEqual([
      { column_name: "garmin_date", data_type: "date", is_nullable: "YES", column_default: null },
      { column_name: "garmin_hash", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "phase", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "plan_id", data_type: "uuid", is_nullable: "YES", column_default: null },
      { column_name: "title", data_type: "text", is_nullable: "YES", column_default: null },
    ]);
    const indexes = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'plan_session_user_id_date_idx'`,
    );
    expect(indexes.rows[0]?.indexdef).toContain("(user_id, date)");
  });

  it("stores a custom workout without plan or phase, which survives its plan being deleted (custom session)", async () => {
    const userId = await createUser();
    const { id: planId } = await createPlan(userId);
    const custom = await createSession(userId, null, { date: "2026-10-02", title: "Hill reps" });
    await createSession(userId, planId, { date: "2026-10-03" });

    expect(custom).toMatchObject({
      planId: null,
      phase: null,
      title: "Hill reps",
      status: "planned",
    });
    await db.execute(sql`delete from plan where id = ${planId}`);
    const left = await db
      .select({ id: planSession.id })
      .from(planSession)
      .where(eq(planSession.userId, userId));
    expect(left).toEqual([{ id: custom.id }]);
  });

  it("refuses a plan session without a phase and a custom one with a phase", async () => {
    const userId = await createUser();
    const { id: planId } = await createPlan(userId);

    expect(
      await postgresErrorCode(createSession(userId, planId, { date: "2026-10-02", phase: null })),
    ).toBe("23514");
    expect(
      await postgresErrorCode(createSession(userId, null, { date: "2026-10-02", phase: "base" })),
    ).toBe("23514");
  });

  it("accepts the skipped status and what Garmin holds for a session (skipped session)", async () => {
    const userId = await createUser();
    const { id: planId } = await createPlan(userId);
    const session = await createSession(userId, planId, { date: "2026-10-02" });

    const [updated] = await db
      .update(planSession)
      .set({
        status: "skipped",
        garminWorkoutId: "900000001",
        garminScheduleId: "800000001",
        garminDate: "2026-10-02",
        garminHash: "a".repeat(64),
      })
      .where(eq(planSession.id, session.id))
      .returning();

    expect(updated).toMatchObject({
      status: "skipped",
      garminWorkoutId: "900000001",
      garminScheduleId: "800000001",
      garminDate: "2026-10-02",
      garminHash: "a".repeat(64),
    });
  });

  it("reads a session stored the 0011 way, with a plan and phase and nothing on Garmin", async () => {
    const userId = await createUser();
    const { id: planId } = await createPlan(userId);
    await db.execute(
      sql`insert into plan_session (plan_id, user_id, date, type, phase, target, steps)
          values (${planId}, ${userId}, '2026-10-05', 'easy', 'base',
                  ${JSON.stringify({ distanceM: 8000, durationS: 2544, zone: "easy" })}::jsonb,
                  ${JSON.stringify([{ kind: "run", zone: "easy", distanceM: 8000, durationS: null }])}::jsonb)`,
    );

    const rows = await db
      .select()
      .from(planSession)
      .where(and(eq(planSession.userId, userId), eq(planSession.date, "2026-10-05")))
      .orderBy(asc(planSession.id));

    expect(rows).toMatchObject([
      {
        planId,
        phase: "base",
        title: null,
        status: "planned",
        garminWorkoutId: null,
        garminDate: null,
        garminHash: null,
      },
    ]);
  });
});

describe("garmin_connection after 0012", () => {
  it("starts with no push, no push error and an empty list of other workouts", async () => {
    const userId = await createUser();
    await connectGarmin(userId);

    const [row] = await db
      .select()
      .from(garminConnection)
      .where(eq(garminConnection.userId, userId));

    expect(row).toMatchObject({
      workoutsPushedAt: null,
      workoutsPushError: null,
      garminCalendar: [],
    });
  });

  it("stores the other workouts and a push error from the shared list, and refuses any other code", async () => {
    const userId = await createUser();
    await connectGarmin(userId);
    const others = [
      otherGarminWorkoutSchema.parse({
        scheduleId: 700000001,
        date: "2026-10-02",
        title: "Strides",
      }),
    ];

    await db
      .update(garminConnection)
      .set({ garminCalendar: others, workoutsPushError: "garmin_unavailable" })
      .where(eq(garminConnection.userId, userId));

    const [row] = await db
      .select()
      .from(garminConnection)
      .where(eq(garminConnection.userId, userId));
    expect(row).toMatchObject({ garminCalendar: others, workoutsPushError: "garmin_unavailable" });
    expect(
      await postgresErrorCode(
        db
          .update(garminConnection)
          .set({ workoutsPushError: "garmin_exploded" as never })
          .where(eq(garminConnection.userId, userId)),
      ),
    ).toBe("23514");
  });
});

// 0018_widen_push_error_codes: the CHECK lists every shared code again, the password login's included,
// since a push stores whatever code stopped it.
describe("garmin_connection after 0018", () => {
  it("accepts every code in the shared list as the push error", async () => {
    const userId = await createUser();
    await connectGarmin(userId);

    for (const code of errorCodeSchema.options) {
      expect(
        await postgresErrorCode(
          db
            .update(garminConnection)
            .set({ workoutsPushError: code })
            .where(eq(garminConnection.userId, userId)),
        ),
      ).toBeUndefined();
      const [row] = await db
        .select({ error: garminConnection.workoutsPushError })
        .from(garminConnection)
        .where(eq(garminConnection.userId, userId));
      expect(row?.error).toBe(code);
    }
    expect(errorCodeSchema.options).toEqual(
      expect.arrayContaining([
        "garmin_credentials_rejected",
        "garmin_mfa_rejected",
        "garmin_login_lost",
      ]),
    );
  });
});
