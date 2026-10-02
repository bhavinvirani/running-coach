import { type GarminActivitySummary, RACE_EVENT_TYPE } from "@running-coach/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity } from "../../src/db/schema";
import { upsertActivities } from "../../src/services/garmin-sync";
import { createUser } from "../seed";

// 0007_add_activity_event_type: Garmin's event type on each run. Nullable without a default, so runs stored
// before it read null until the next sync or Import history rewrites them.

function summary(eventType: string | null): GarminActivitySummary {
  return {
    garminActivityId: 21_474_836_480,
    type: "running",
    startUtc: "2026-09-06T05:30:00Z",
    startLocal: "2026-09-06T07:30:00",
    tz: null,
    distanceM: 10_200,
    durationS: 3300,
    avgHr: 178,
    maxHr: 192,
    cadence: 176,
    calories: 700,
    elevationGainM: 40,
    isIndoor: false,
    isManual: false,
    eventType,
  };
}

async function stored(userId: string) {
  const [row] = await db.select().from(activity).where(eq(activity.userId, userId));
  if (!row) throw new Error("no run stored");
  return row;
}

describe("activity.event_type", () => {
  it("is a nullable text column without a default, so rows stored before it read null", async () => {
    const result = await db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      sql`select data_type, is_nullable, column_default from information_schema.columns
          where table_name = 'activity' and column_name = 'event_type'`,
    );

    expect(result.rows).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
  });

  it("reads null for a run stored without an event type (run synced before 0007)", async () => {
    const userId = await createUser();
    await db.insert(activity).values({
      userId,
      garminActivityId: 1,
      type: "running",
      startUtc: new Date("2026-09-06T05:30:00Z"),
      startLocal: "2026-09-06 07:30:00",
      distanceM: 10_200,
      durationS: 3300,
    });

    expect((await stored(userId)).eventType).toBeNull();
  });

  it.each([[RACE_EVENT_TYPE], ["uncategorized"], [null]])(
    "stores the event type %s from the sync's upsert",
    async (eventType) => {
      const userId = await createUser();

      expect(await upsertActivities(userId, [summary(eventType)])).toBe(1);

      expect((await stored(userId)).eventType).toBe(eventType);
    },
  );

  it("updates a run the runner marked a race on Garmin after it synced (edited activity)", async () => {
    const userId = await createUser();
    await upsertActivities(userId, [summary("uncategorized")]);
    const before = await stored(userId);

    expect(await upsertActivities(userId, [summary(RACE_EVENT_TYPE)])).toBe(1);

    expect(await stored(userId)).toMatchObject({ id: before.id, eventType: RACE_EVENT_TYPE });
  });

  it("fills the event type of a run stored before 0007 on the next upsert", async () => {
    const userId = await createUser();
    await upsertActivities(userId, [summary(RACE_EVENT_TYPE)]);
    await db.update(activity).set({ eventType: null }).where(eq(activity.userId, userId));

    expect(await upsertActivities(userId, [summary(RACE_EVENT_TYPE)])).toBe(1);

    expect((await stored(userId)).eventType).toBe(RACE_EVENT_TYPE);
  });

  it.each([[RACE_EVENT_TYPE], [null]])(
    "writes nothing when the run arrives again with the same event type %s (duplicate activities)",
    async (eventType) => {
      const userId = await createUser();
      await upsertActivities(userId, [summary(eventType)]);
      const before = await stored(userId);

      expect(await upsertActivities(userId, [summary(eventType)])).toBe(0);

      expect((await stored(userId)).updatedAt).toEqual(before.updatedAt);
    },
  );
});
