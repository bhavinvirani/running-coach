import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity, activityLap, activityStream } from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { createLongRun, createUser } from "../seed";

// 0006_create_activity_detail: a run's laps and its row-aligned samples, route and HR zones. The runner is in
// migrate.test.ts.

async function indexesOf(table: string): Promise<string[]> {
  const result = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where tablename = ${table} order by indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

describe("activity_lap and activity_stream", () => {
  it("are created by the migrations with one lap per number and one stream per run", async () => {
    expect(await indexesOf("activity_lap")).toEqual([
      "activity_lap_activity_id_idx_unique",
      "activity_lap_pkey",
    ]);
    expect(await indexesOf("activity_stream")).toEqual([
      "activity_stream_activity_id_unique",
      "activity_stream_pkey",
    ]);
  });

  it("round-trip laps with null HR and cadence (missing HR)", async () => {
    const run = await createLongRun(await createUser());

    await db.insert(activityLap).values([
      {
        activityId: run.id,
        idx: 2,
        distanceM: 1000,
        durationS: 301.25,
        avgHr: 151,
        avgCadence: 170.5,
      },
      {
        activityId: run.id,
        idx: 1,
        distanceM: 1000,
        durationS: 390.422,
        avgHr: null,
        avgCadence: null,
      },
    ]);

    const laps = await db
      .select()
      .from(activityLap)
      .where(eq(activityLap.activityId, run.id))
      .orderBy(activityLap.idx);
    expect(laps).toMatchObject([
      { idx: 1, distanceM: 1000, durationS: 390.422, avgHr: null, avgCadence: null },
      { idx: 2, distanceM: 1000, durationS: 301.25, avgHr: 151, avgCadence: 170.5 },
    ]);
    expect(
      await postgresErrorCode(
        db.insert(activityLap).values({ activityId: run.id, idx: 1, distanceM: 1, durationS: 1 }),
      ),
    ).toBe("23505");
  });

  it("round-trips samples with null elements, absent series as null columns, the route and zones (GPS glitches, indoor run)", async () => {
    const run = await createLongRun(await createUser());

    await db.insert(activityStream).values({
      activityId: run.id,
      elapsedS: [0, 5, 10.5],
      distanceM: [0, 14.25, 30],
      hr: [null, 141, 143],
      cadence: [160, null, 162.5],
      elevationM: null,
      speedMps: null,
      route: [
        [0.001, -30.002],
        [0.0015, -30.0025],
      ],
      hrZones: [{ zone: 1, lowBpm: 98, seconds: 120 }],
    });

    const [stored] = await db
      .select()
      .from(activityStream)
      .where(eq(activityStream.activityId, run.id));
    expect(stored).toMatchObject({
      elapsedS: [0, 5, 10.5],
      distanceM: [0, 14.25, 30],
      hr: [null, 141, 143],
      cadence: [160, null, 162.5],
      elevationM: null,
      speedMps: null,
      route: [
        [0.001, -30.002],
        [0.0015, -30.0025],
      ],
      hrZones: [{ zone: 1, lowBpm: 98, seconds: 120 }],
    });
  });

  it("stores empty series for a manual entry", async () => {
    const run = await createLongRun(await createUser());

    await db.insert(activityStream).values({ activityId: run.id, elapsedS: [], distanceM: [] });

    const [stored] = await db.select().from(activityStream);
    expect(stored).toMatchObject({ elapsedS: [], distanceM: [], hr: null, route: null });
  });

  it("allows one stream row per run", async () => {
    const run = await createLongRun(await createUser());
    const row = { activityId: run.id, elapsedS: [0], distanceM: [0] };
    await db.insert(activityStream).values(row);

    expect(await postgresErrorCode(db.insert(activityStream).values(row))).toBe("23505");
  });

  it("is deleted with its run, and leaves other runs' detail alone", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);
    const other = await createLongRun(userId, 10_000_000_006);
    for (const activityId of [run.id, other.id]) {
      await db.insert(activityLap).values({ activityId, idx: 1, distanceM: 1000, durationS: 300 });
      await db.insert(activityStream).values({ activityId, elapsedS: [0], distanceM: [0] });
    }

    await db.delete(activity).where(eq(activity.id, run.id));

    const laps = await db.select({ activityId: activityLap.activityId }).from(activityLap);
    const streams = await db.select({ activityId: activityStream.activityId }).from(activityStream);
    expect(laps).toEqual([{ activityId: other.id }]);
    expect(streams).toEqual([{ activityId: other.id }]);
  });
});
