import {
  type ActivityShoe,
  type CreateShoeRequest,
  ErrorCode,
  type ShoeInput,
  type ShoesResponse,
} from "@running-coach/shared";
import { and, asc, count, desc, eq, ne, sql } from "drizzle-orm";
import { type DbTransaction, db } from "../db/client";
import { activity, shoe } from "../db/schema";
import { DomainError } from "../lib/errors";
import { advisoryLockKey } from "../lib/lock-key";
import { logger } from "../lib/logger";
import { runNotFound } from "./activity-detail";

// The runner's pairs (slice 52). Database only, no Garmin: the sync puts the active pair on each new run
// (writeActivities in garmin-sync.ts), and these change the pairs and a run's pair. Every change of a pair
// answers the whole list, as GET /api/shoes does.

const log = logger.child({ module: "shoes" });

function shoeNotFound(): DomainError {
  return new DomainError(ErrorCode.notFound, 404, "That pair does not exist.");
}

/**
 * Serializes the changes of a user's active pair. Locking the user's shoe rows is not enough: a user
 * without pairs has none, and two creates with active would both insert one and the second would break
 * the one-active index (a 500). Transaction-scoped, so commit or rollback releases it.
 */
async function lockActivePair(tx: DbTransaction, userId: string): Promise<void> {
  const key = advisoryLockKey("shoes", userId);
  await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
}

/** Clears the user's active pair, except `keep`. Under lockActivePair, before another pair is made active. */
async function deactivateOthers(tx: DbTransaction, userId: string, keep?: string): Promise<void> {
  await tx
    .update(shoe)
    .set({ active: false })
    .where(
      and(eq(shoe.userId, userId), eq(shoe.active, true), keep ? ne(shoe.id, keep) : undefined),
    );
}

/**
 * GET /api/shoes: every pair with its totals, summed from its runs in one query. The active pair first, then
 * the pairs in use newest first, then the retired ones, latest retired first.
 */
export async function listShoes(userId: string): Promise<ShoesResponse> {
  const rows = await db
    .select({
      id: shoe.id,
      brand: shoe.brand,
      model: shoe.model,
      colour: shoe.colour,
      nickname: shoe.nickname,
      retireDistanceM: shoe.retireDistanceM,
      startDistanceM: shoe.startDistanceM,
      active: shoe.active,
      retiredAt: shoe.retiredAt,
      runsDistanceM: sql<number>`coalesce(sum(${activity.distanceM}), 0)`.mapWith(Number),
      runs: count(activity.id),
      durationS: sql<number>`coalesce(sum(${activity.durationS}), 0)`.mapWith(Number),
    })
    .from(shoe)
    // The user filter on the run too: a link to another user's run never counts, should one exist.
    .leftJoin(activity, and(eq(activity.shoeId, shoe.id), eq(activity.userId, shoe.userId)))
    .where(eq(shoe.userId, userId))
    .groupBy(shoe.id)
    .orderBy(
      desc(shoe.active),
      sql`${shoe.retiredAt} is not null`,
      sql`${shoe.retiredAt} desc nulls last`,
      desc(shoe.createdAt),
      asc(shoe.id),
    );
  return {
    shoes: rows.map(({ runsDistanceM, retiredAt, ...row }) => ({
      ...row,
      retiredAt: retiredAt?.toISOString() ?? null,
      distanceM: row.startDistanceM + runsDistanceM,
    })),
  };
}

/** POST /api/shoes: a new pair; active makes it the pair the sync puts on new runs, in place of the last. */
export async function createShoe(userId: string, body: CreateShoeRequest): Promise<ShoesResponse> {
  const id = await db.transaction(async (tx) => {
    if (body.active) {
      await lockActivePair(tx, userId);
      await deactivateOthers(tx, userId);
    }
    const [row] = await tx
      .insert(shoe)
      .values({ userId, ...body })
      .returning({ id: shoe.id });
    if (!row) throw new Error("insert returned nothing");
    return row.id;
  });
  log.info({ userId, shoeId: id, active: body.active }, "pair added");
  return listShoes(userId);
}

/** PUT /api/shoes/:id: the pair's details; whether it is active or retired stays. */
export async function updateShoe(
  userId: string,
  id: string,
  input: ShoeInput,
): Promise<ShoesResponse> {
  const [row] = await db
    .update(shoe)
    .set(input)
    .where(and(eq(shoe.id, id), eq(shoe.userId, userId)))
    .returning({ id: shoe.id });
  if (!row) throw shoeNotFound();
  return listShoes(userId);
}

/** DELETE /api/shoes/:id: the pair goes; its runs stay and lose their pair (on delete set null). */
export async function deleteShoe(userId: string, id: string): Promise<ShoesResponse> {
  const [row] = await db
    .delete(shoe)
    .where(and(eq(shoe.id, id), eq(shoe.userId, userId)))
    .returning({ id: shoe.id });
  if (!row) throw shoeNotFound();
  log.info({ userId, shoeId: id }, "pair deleted");
  return listShoes(userId);
}

/**
 * POST /api/shoes/:id/active: the pair the sync puts on new runs from now on; the last one stops being
 * active. A retired pair comes back in use. Activating the active pair changes nothing.
 */
export async function activateShoe(userId: string, id: string): Promise<ShoesResponse> {
  await db.transaction(async (tx) => {
    await lockActivePair(tx, userId);
    const [row] = await tx
      .select({ active: shoe.active })
      .from(shoe)
      .where(and(eq(shoe.id, id), eq(shoe.userId, userId)));
    if (!row) throw shoeNotFound();
    if (row.active) return;
    await deactivateOthers(tx, userId, id);
    await tx.update(shoe).set({ active: true, retiredAt: null }).where(eq(shoe.id, id));
    log.info({ userId, shoeId: id }, "pair made active");
  });
  return listShoes(userId);
}

/**
 * POST /api/shoes/:id/retire: the pair stops being active and moves to retired. Retiring a retired pair
 * keeps the day it was first retired.
 */
export async function retireShoe(userId: string, id: string): Promise<ShoesResponse> {
  // Clearing active never breaks the one-active index, so no lock.
  const [row] = await db
    .update(shoe)
    .set({ active: false, retiredAt: sql`coalesce(${shoe.retiredAt}, now())` })
    .where(and(eq(shoe.id, id), eq(shoe.userId, userId)))
    .returning({ id: shoe.id });
  if (!row) throw shoeNotFound();
  return listShoes(userId);
}

/**
 * PUT /api/activities/:id/shoe: the pair the run wore, any of the runner's (a retired one too, since an
 * old run may have worn it), or null for none. A run the next sync rewrites keeps it (writeActivities).
 */
export async function setActivityShoe(
  userId: string,
  activityId: string,
  shoeId: string | null,
): Promise<ActivityShoe> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ id: activity.id })
      .from(activity)
      .where(and(eq(activity.id, activityId), eq(activity.userId, userId)));
    if (!run) throw runNotFound();
    if (shoeId !== null) {
      // Key share holds off a delete of the pair until commit, so the link below cannot break its key.
      const [pair] = await tx
        .select({ id: shoe.id })
        .from(shoe)
        .where(and(eq(shoe.id, shoeId), eq(shoe.userId, userId)))
        .for("key share");
      if (!pair) throw shoeNotFound();
    }
    // updated_at stays: it records the last change Garmin made to the run (best-efforts.ts).
    await tx
      .update(activity)
      .set({ shoeId, updatedAt: sql`${activity.updatedAt}` })
      .where(eq(activity.id, activityId));
    return { shoeId };
  });
}
