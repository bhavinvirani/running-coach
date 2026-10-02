import { BEST_EFFORTS_VERSION } from "@running-coach/engine";
import type { GarminActivitySummary } from "@running-coach/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity } from "../../src/db/schema";
import { upsertActivities } from "../../src/services/garmin-sync";
import { createUser } from "../seed";

// 0010_add_best_efforts_failed_at: when a best-efforts batch last failed on a run. Nullable, so runs stored
// before it read null (never failed) and a batch may take them at once.

const FAILED_AT = new Date("2026-09-28T10:00:00Z");

function summary(values: Partial<GarminActivitySummary> = {}): GarminActivitySummary {
  return {
    garminActivityId: 21_474_836_481,
    type: "running",
    startUtc: "2026-09-06T05:30:00Z",
    startLocal: "2026-09-06T07:30:00",
    tz: null,
    distanceM: 10_200,
    durationS: 3300,
    avgHr: 150,
    maxHr: 170,
    cadence: 172,
    calories: 700,
    elevationGainM: 40,
    isIndoor: false,
    isManual: false,
    eventType: "uncategorized",
    ...values,
  };
}

async function stored(userId: string) {
  const [row] = await db.select().from(activity).where(eq(activity.userId, userId));
  if (!row) throw new Error("no run stored");
  return row;
}

async function failedRun(userId: string) {
  await upsertActivities(userId, [summary()]);
  await db
    .update(activity)
    .set({
      bestEffortsVersion: BEST_EFFORTS_VERSION - 1,
      bestEffortsAttempts: 2,
      bestEffortsFailedAt: FAILED_AT,
    })
    .where(eq(activity.userId, userId));
}

describe("activity.best_efforts_failed_at", () => {
  it("is a nullable timestamptz without a default", async () => {
    const result = await db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      sql`select data_type, is_nullable, column_default from information_schema.columns
          where table_name = 'activity' and column_name = 'best_efforts_failed_at'`,
    );

    expect(result.rows).toEqual([
      { data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
    ]);
  });

  it("reads null for a run stored without it (run synced before 0010)", async () => {
    const userId = await createUser();
    await db.execute(
      sql`insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m, duration_s)
          values (${userId}, 1, 'running', '2026-09-06T05:30:00Z', '2026-09-06 07:30:00', 10200, 3300)`,
    );

    expect((await stored(userId)).bestEffortsFailedAt).toBeNull();
  });

  it.each([
    ["distance", { distanceM: 10_150 }],
    ["timer time", { durationS: 3250 }],
  ])(
    "is cleared by the sync's upsert with the attempts when Garmin changes the run's %s (edited activity)",
    async (_, change) => {
      const userId = await createUser();
      await failedRun(userId);

      expect(await upsertActivities(userId, [summary(change)])).toBe(1);

      expect(await stored(userId)).toMatchObject({
        bestEffortsVersion: null,
        bestEffortsAttempts: 0,
        bestEffortsFailedAt: null,
      });
    },
  );

  it("is kept by the sync's upsert when another field changes", async () => {
    const userId = await createUser();
    await failedRun(userId);

    expect(await upsertActivities(userId, [summary({ avgHr: 152 })])).toBe(1);

    expect((await stored(userId)).bestEffortsFailedAt).toEqual(FAILED_AT);
  });
});
