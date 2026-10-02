import type { GarminRecord } from "@running-coach/shared";
import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity, bestEffort, garminConnection, user } from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { connectGarmin, createRun, createUser } from "../seed";

// 0008_create_best_effort: each run's fastest stretch per distance, the run's best-efforts version and
// Garmin's own records on the connection. Expand only: every new column is nullable without a default, so
// rows stored before it read null. The runner is in migrate.test.ts.

async function indexesOf(table: string): Promise<string[]> {
  const result = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where tablename = ${table} order by indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

async function columnsOf(table: string, names: string[]) {
  const result = await db.execute<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    sql`select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_name = ${table} and column_name in (${sql.join(
          names.map((name) => sql`${name}`),
          sql`, `,
        )}) order by column_name`,
  );
  return result.rows;
}

async function effortsOf(activityId: string) {
  return db
    .select()
    .from(bestEffort)
    .where(eq(bestEffort.activityId, activityId))
    .orderBy(asc(bestEffort.timeS));
}

describe("best_effort", () => {
  it("is created with one effort per run and distance and the index the personal-bests query reads", async () => {
    expect(await indexesOf("best_effort")).toEqual([
      "best_effort_activity_id_distance_key_unique",
      "best_effort_pkey",
      "best_effort_user_id_distance_key_time_s_idx",
    ]);
  });

  it("round-trips unrounded times and rejects a second effort for the same run and distance (idempotent recompute)", async () => {
    const userId = await createUser();
    const run = await createRun(userId);

    await db.insert(bestEffort).values([
      { userId, activityId: run.id, distanceKey: "5k", timeS: 1625.375, startS: 812.5 },
      { userId, activityId: run.id, distanceKey: "1k", timeS: 301.0625, startS: 0 },
    ]);

    expect(await effortsOf(run.id)).toMatchObject([
      { distanceKey: "1k", timeS: 301.0625, startS: 0 },
      { distanceKey: "5k", timeS: 1625.375, startS: 812.5 },
    ]);
    expect(
      await postgresErrorCode(
        db
          .insert(bestEffort)
          .values({ userId, activityId: run.id, distanceKey: "5k", timeS: 1600, startS: 0 }),
      ),
    ).toBe("23505");
  });

  it("rejects a distance key outside the shared list", async () => {
    const userId = await createUser();
    const run = await createRun(userId);

    expect(
      await postgresErrorCode(
        db.execute(
          sql`insert into best_effort (user_id, activity_id, distance_key, time_s, start_s)
              values (${userId}, ${run.id}, '3k', 600, 0)`,
        ),
      ),
    ).toBe("23514");
  });

  it("goes with its run when the run is deleted, and with the user", async () => {
    const userId = await createUser();
    const kept = await createRun(userId, { garminActivityId: 1 });
    const deleted = await createRun(userId, { garminActivityId: 2 });
    for (const run of [kept, deleted]) {
      await db
        .insert(bestEffort)
        .values({ userId, activityId: run.id, distanceKey: "1k", timeS: 300, startS: 0 });
    }

    await db.delete(activity).where(eq(activity.id, deleted.id));
    expect(await effortsOf(deleted.id)).toEqual([]);
    expect(await effortsOf(kept.id)).toHaveLength(1);

    await db.delete(user).where(eq(user.id, userId));
    expect(await db.select().from(bestEffort)).toEqual([]);
  });
});

describe("activity.best_efforts_version", () => {
  it("is a nullable smallint without a default, so runs stored before it read null and count as pending", async () => {
    expect(await columnsOf("activity", ["best_efforts_version"])).toEqual([
      {
        column_name: "best_efforts_version",
        data_type: "smallint",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
    const run = await createRun(await createUser());

    expect(run.bestEffortsVersion).toBeNull();
  });
});

describe("garmin_connection.garmin_records", () => {
  it("adds nullable records and their fetch time, null on a connection stored before them", async () => {
    expect(await columnsOf("garmin_connection", ["garmin_records", "garmin_records_at"])).toEqual([
      {
        column_name: "garmin_records",
        data_type: "jsonb",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "garmin_records_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
    const userId = await createUser();
    await connectGarmin(userId);

    const [stored] = await db
      .select({
        records: garminConnection.garminRecords,
        at: garminConnection.garminRecordsAt,
      })
      .from(garminConnection)
      .where(eq(garminConnection.userId, userId));
    expect(stored).toEqual({ records: null, at: null });
  });

  it("round-trips Garmin's records as the shared shape", async () => {
    const userId = await createUser();
    await connectGarmin(userId);
    const records: GarminRecord[] = [
      { distanceKey: "1k", timeS: 288.41, achievedAt: "2026-09-20T06:30:00Z" },
      { distanceKey: "half", timeS: 7731.52, achievedAt: "2026-08-30T05:45:00Z" },
    ];
    const at = new Date("2026-10-01T12:00:00Z");

    await db
      .update(garminConnection)
      .set({ garminRecords: records, garminRecordsAt: at })
      .where(eq(garminConnection.userId, userId));

    const [stored] = await db
      .select({
        records: garminConnection.garminRecords,
        at: garminConnection.garminRecordsAt,
      })
      .from(garminConnection)
      .where(eq(garminConnection.userId, userId));
    expect(stored).toEqual({ records, at });
  });
});
