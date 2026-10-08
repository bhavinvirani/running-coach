import { DEFAULT_SHOE_RETIRE_DISTANCE_M } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { shoe, user } from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { createRunOn, createUser } from "../seed";
import { createPair, pairOfRun, wearPair } from "../seed-shoes";

// 0019_add_shoes: the runner's pairs, at most one active and never a retired one active, and the pair a run
// wore on activity.shoe_id. Expand only: a new table and a nullable column. The table is in migrate.test.ts.

describe("shoe", () => {
  it("stores a new pair with a 650 km retire goal, no start distance, in use and not active", async () => {
    const userId = await createUser();

    const pair = await createPair(userId);

    expect(pair).toMatchObject({
      retireDistanceM: DEFAULT_SHOE_RETIRE_DISTANCE_M,
      startDistanceM: 0,
      active: false,
      retiredAt: null,
      colour: null,
      nickname: null,
    });
  });

  it("keeps one active pair per user, while another user has their own (one active pair)", async () => {
    const userId = await createUser();
    const other = await createUser("other@example.com");
    await createPair(userId, { active: true });
    await createPair(other, { active: true });

    expect(await postgresErrorCode(createPair(userId, { active: true }))).toBe("23505");
    // Any number of pairs that are not active.
    await createPair(userId);
    await createPair(userId);
  });

  it("never stores a retired pair as active (retired never active)", async () => {
    const userId = await createUser();

    expect(
      await postgresErrorCode(createPair(userId, { active: true, retiredAt: new Date() })),
    ).toBe("23514");
  });

  it("goes with its user (cascade)", async () => {
    const userId = await createUser();
    await createPair(userId, { active: true });

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(shoe)).toEqual([]);
  });
});

describe("activity.shoe_id", () => {
  it("reads null on a run stored without a pair (old rows still read)", async () => {
    const userId = await createUser();
    const run = await createRunOn(userId, "2026-09-27");

    expect(run.shoeId).toBeNull();
  });

  it("keeps the run and clears its pair when the pair is deleted (on delete set null)", async () => {
    const userId = await createUser();
    const pair = await createPair(userId);
    const run = await createRunOn(userId, "2026-09-27");
    await wearPair(run.id, pair.id);

    await db.delete(shoe).where(eq(shoe.id, pair.id));

    expect(await pairOfRun(run.id)).toBeNull();
  });

  it("refuses a pair that does not exist (foreign key)", async () => {
    const userId = await createUser();
    const run = await createRunOn(userId, "2026-09-27");

    expect(await postgresErrorCode(wearPair(run.id, "0b6c3c55-8d5d-4f63-9a31-1c2f0f4b7e10"))).toBe(
      "23503",
    );
  });
});
