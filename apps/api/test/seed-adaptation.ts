import { asc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  type activity,
  type NewPlanAdjustmentRow,
  type NewTrainingPauseRow,
  planAdjustment,
  type PlanAdjustmentRow,
  type PlanSessionRow,
  trainingPause,
  type TrainingPauseRow,
} from "../src/db/schema";
import { createRun, nextGarminActivityId } from "./seed";

// Fictional rows for the adaptation's integration tests: pauses, the change log and runs across zones.

/** The session as the change log stores it, before or after a change. */
export function adjustedSession(row: PlanSessionRow) {
  return {
    type: row.type,
    title: row.title,
    status: row.status,
    steps: row.steps,
    target: row.target,
  };
}

/** A pause of the user's, open (no ended_on) and for illness unless `values` say otherwise. */
export async function createPause(
  userId: string,
  values: Partial<Omit<NewTrainingPauseRow, "userId">> & { startedOn: string },
): Promise<TrainingPauseRow> {
  const [row] = await db
    .insert(trainingPause)
    .values({ userId, reason: "sick", ...values })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/**
 * A change logged for a session, applied by the coach by default, with the session as stored now as both
 * before and after unless `values` say otherwise. It writes the log only: the session row is left as it is.
 */
export async function createAdjustment(
  userId: string,
  session: PlanSessionRow | null,
  values: Partial<Omit<NewPlanAdjustmentRow, "userId">> = {},
): Promise<PlanAdjustmentRow> {
  const snapshot = session ? adjustedSession(session) : null;
  const [row] = await db
    .insert(planAdjustment)
    .values({
      userId,
      planSessionId: session?.id ?? null,
      source: "coach",
      kind: "scale",
      outcome: "applied",
      requested: { kind: "scale", factor: 0.8 },
      applied: { kind: "scale", factor: 0.8 },
      before: snapshot,
      after: snapshot,
      ...values,
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/** The user's plan_adjustment rows, oldest first. */
export async function storedAdjustments(userId: string): Promise<PlanAdjustmentRow[]> {
  return db
    .select()
    .from(planAdjustment)
    .where(eq(planAdjustment.userId, userId))
    .orderBy(asc(planAdjustment.createdAt), asc(planAdjustment.id));
}

/**
 * A run started at a wall-clock time in its own zone (`startLocal`, "YYYY-MM-DD HH:MM:SS") and a UTC
 * instant that may fall on another date, as a run in a zone ahead of or behind UTC has.
 */
export async function createRunAt(
  userId: string,
  startLocal: string,
  startUtc: string,
  values: Partial<Omit<typeof activity.$inferInsert, "userId">> = {},
) {
  return createRun(userId, {
    garminActivityId: nextGarminActivityId(),
    startLocal,
    startUtc: new Date(startUtc),
    ...values,
  });
}
