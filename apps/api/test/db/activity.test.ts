import type { GarminActivitySummary } from "@running-coach/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity, user } from "../../src/db/schema";
import { upsertActivities } from "../../src/services/garmin-sync";
import { createUser } from "../seed";

// 0003_create_activity: the table, its keys, and the sync's upsert path.

function summary(overrides: Partial<GarminActivitySummary> = {}): GarminActivitySummary {
  return {
    // Above 2^31, as real Garmin ids are.
    garminActivityId: 21_474_836_480,
    type: "running",
    startUtc: "2026-09-27T06:00:00Z",
    startLocal: "2026-09-27T08:00:00",
    tz: null,
    distanceM: 10_000,
    durationS: 3000,
    avgHr: 150,
    maxHr: 170,
    cadence: 170,
    calories: 600,
    elevationGainM: 50,
    isIndoor: false,
    isManual: false,
    ...overrides,
  };
}

async function rows(userId: string) {
  return db.select().from(activity).where(eq(activity.userId, userId));
}

describe("activity", () => {
  it("is created by the migrations with its unique key and list index", async () => {
    const result = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'activity' order by indexname`,
    );

    expect(result.rows.map((row) => row.indexname)).toEqual([
      "activity_pkey",
      "activity_user_id_garmin_activity_id_idx",
      "activity_user_id_start_utc_idx",
    ]);
  });

  it("stores a run with SI units, a large Garmin id and the wall-clock start as given", async () => {
    const userId = await createUser();

    expect(await upsertActivities(userId, [summary()])).toBe(1);

    const [row] = await rows(userId);
    expect(row).toMatchObject({
      garminActivityId: 21_474_836_480,
      startUtc: new Date("2026-09-27T06:00:00Z"),
      startLocal: "2026-09-27 08:00:00",
      distanceM: 10_000,
      tz: null,
      summary: null,
    });
  });

  it("writes nothing when the same run arrives again unchanged", async () => {
    const userId = await createUser();
    await upsertActivities(userId, [summary()]);
    const [before] = await rows(userId);

    expect(await upsertActivities(userId, [summary()])).toBe(0);

    const [after] = await rows(userId);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it("updates a run edited on Garmin in place and keeps a time zone a later call filled in", async () => {
    const userId = await createUser();
    await upsertActivities(userId, [summary()]);
    await db.update(activity).set({ tz: "Europe/Berlin" }).where(eq(activity.userId, userId));

    expect(await upsertActivities(userId, [summary({ distanceM: 10_250, avgHr: null })])).toBe(1);

    const stored = await rows(userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ distanceM: 10_250, avgHr: null, tz: "Europe/Berlin" });
  });

  it("keeps one row per user and Garmin id, and lets two users hold the same Garmin id", async () => {
    const ownerId = await createUser();
    const otherId = await createUser("other@example.com");

    await upsertActivities(ownerId, [summary()]);
    await upsertActivities(otherId, [summary()]);
    await upsertActivities(ownerId, [summary(), summary({ garminActivityId: 21_474_836_481 })]);

    expect(await rows(ownerId)).toHaveLength(2);
    expect(await rows(otherId)).toHaveLength(1);
  });

  it("is deleted with its user", async () => {
    const userId = await createUser();
    await upsertActivities(userId, [summary()]);

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(activity)).toHaveLength(0);
  });
});
