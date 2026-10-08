import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_SHOE_RETIRE_DISTANCE_M,
  type ShoeInput,
  shoeInputSchema,
} from "@running-coach/shared";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { activity, type NewShoeRow, shoe } from "../src/db/schema";

// Fictional pairs for the shoe tests; the brand and models are made up.

/** A pair as the runner types it, parsed so it cannot drift from the contract. */
export const SHOE_INPUT: ShoeInput = shoeInputSchema.parse({
  brand: "Acme",
  model: "Glide 3",
  colour: null,
  nickname: null,
  retireDistanceM: DEFAULT_SHOE_RETIRE_DISTANCE_M,
  startDistanceM: 0,
});

/** A pair of the user's written directly: in use and not active unless `values` say otherwise. */
export async function createPair(userId: string, values: Partial<Omit<NewShoeRow, "userId">> = {}) {
  const [row] = await db
    .insert(shoe)
    .values({ userId, brand: SHOE_INPUT.brand, model: SHOE_INPUT.model, ...values })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/** Puts the pair on the run directly, or none with null. */
export async function wearPair(activityId: string, shoeId: string | null): Promise<void> {
  await db.update(activity).set({ shoeId }).where(eq(activity.id, activityId));
}

/** The pair a run wears, null for none. */
export async function pairOfRun(activityId: string): Promise<string | null> {
  const [row] = await db
    .select({ shoeId: activity.shoeId })
    .from(activity)
    .where(eq(activity.id, activityId));
  if (!row) throw new Error("no such run");
  return row.shoeId;
}

/** The pair each of the user's runs wears, keyed by Garmin id. */
export async function pairsOfRuns(userId: string): Promise<Record<number, string | null>> {
  const rows = await db
    .select({ garminActivityId: activity.garminActivityId, shoeId: activity.shoeId })
    .from(activity)
    .where(eq(activity.userId, userId))
    .orderBy(asc(activity.garminActivityId));
  return Object.fromEntries(rows.map((row) => [row.garminActivityId, row.shoeId]));
}

/** The user's pairs that are active, by id. */
export async function activePairs(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: shoe.id, active: shoe.active })
    .from(shoe)
    .where(eq(shoe.userId, userId));
  return rows.filter((row) => row.active).map((row) => row.id);
}

/**
 * Resolves once a query in this database waits for a row lock another connection holds, so a test can
 * commit that connection's transaction while the query is known to wait.
 */
export async function aQueryWaitsForARowLock(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await db.execute<{ count: string }>(
      sql`select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where not l.granted and l.locktype <> 'advisory' and a.datname = current_database()`,
    );
    if (Number(result.rows[0]?.count) > 0) return;
    await sleep(20);
  }
  throw new Error("no query waited for a row lock");
}
