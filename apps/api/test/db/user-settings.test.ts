import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { user, userSettings } from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { createUser } from "../seed";

// 0001_create_user_settings: one row of display and coach settings per user, inserted with the column
// defaults when the user is created (auth.ts). The runner is in migrate.test.ts.

const settingsOf = (userId: string) =>
  db.select().from(userSettings).where(eq(userSettings.userId, userId));

describe("user_settings", () => {
  it("gives a new user one row with the defaults: km, UTC, standard, no HR zones, no Claude key", async () => {
    const userId = await createUser();

    const rows = await settingsOf(userId);

    expect(rows).toEqual([
      expect.objectContaining({
        userId,
        units: "km",
        timezone: "UTC",
        coachDetail: "standard",
        hrZones: null,
        claudeKeyEnc: null,
      }),
    ]);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("allows one row per user", async () => {
    const userId = await createUser();

    expect(await postgresErrorCode(db.insert(userSettings).values({ userId }))).toBe("23505");
  });

  it("rejects units and coach detail outside the shared lists", async () => {
    const userId = await createUser();
    const ofUser = eq(userSettings.userId, userId);

    const badUnits = db
      .update(userSettings)
      .set({ units: "furlongs" as never })
      .where(ofUser);
    const badDetail = db
      .update(userSettings)
      .set({ coachDetail: "verbose" as never })
      .where(ofUser);

    expect(await postgresErrorCode(badUnits)).toBe("23514");
    expect(await postgresErrorCode(badDetail)).toBe("23514");
  });

  it("is deleted with its user", async () => {
    const userId = await createUser();

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(userSettings)).toHaveLength(0);
  });

  it("updates updated_at on change and keeps other users' rows", async () => {
    const ownerId = await createUser();
    const otherId = await createUser("other@example.com");
    const [before] = await settingsOf(ownerId);

    const [after] = await db
      .update(userSettings)
      .set({ units: "mi" })
      .where(eq(userSettings.userId, ownerId))
      .returning();

    expect(after?.units).toBe("mi");
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
    const [other] = await settingsOf(otherId);
    expect(other?.units).toBe("km");
  });
});
