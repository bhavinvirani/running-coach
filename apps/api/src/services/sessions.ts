import { HARD_DAY_MIN_GAP_DAYS, hardSessionTooClose, sessionTarget } from "@running-coach/engine";
import {
  type CustomSessionInput,
  ErrorCode,
  type MoveSessionResponse,
  type MoveWarning,
  type PlanPaces,
  type SessionDetailResponse,
  type SessionStatus,
} from "@running-coach/shared";
import { and, eq, gte, inArray, isNull, lte, ne, notInArray, or } from "drizzle-orm";
import { db } from "../db/client";
import { plan, planSession, type PlanSessionRow, userSettings } from "../db/schema";
import { DomainError } from "../lib/errors";
import { addDays, localDateOf, mondayOf } from "../lib/local-date";
import { toPlanSession } from "./session-view";
import { queueWorkoutPush, readPushStatus } from "./workout-push";

// One session of the runner's calendar: reading it, building a custom workout, moving, editing and
// skipping (SPEC: Garmin calendar). Every change queues a workout push, so Garmin follows within a minute.
// Only the active plan's sessions and the runner's custom workouts can change, from today on: past, done,
// missed and skipped sessions are history, and missed runs are never made up (SPEC: Plan engine).

/** Statuses a runner can still change. */
const CHANGEABLE: readonly SessionStatus[] = ["planned", "moved"];

function notFound(): DomainError {
  return new DomainError(ErrorCode.notFound, 404, "No such session.");
}

function locked(detail: string): DomainError {
  return new DomainError(ErrorCode.sessionLocked, 409, detail);
}

function planMissing(): DomainError {
  return new DomainError(
    ErrorCode.planMissing,
    409,
    "A workout uses your plan's paces. Set a goal to get a plan first.",
  );
}

async function settingsOf(userId: string) {
  const [row] = await db
    .select({ units: userSettings.units, timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  // requireUser found the user, and its settings row is created with it.
  if (!row) throw new Error("The signed-in user has no settings row");
  return row;
}

async function activePlanOf(userId: string): Promise<{ id: string; paces: PlanPaces } | null> {
  const [row] = await db
    .select({ id: plan.id, paces: plan.paces })
    .from(plan)
    .where(and(eq(plan.userId, userId), eq(plan.status, "active")));
  return row ?? null;
}

/** The runner's own session; another runner's is as unknown as a missing one. */
async function ownSession(userId: string, id: string): Promise<PlanSessionRow> {
  const [row] = await db
    .select()
    .from(planSession)
    .where(and(eq(planSession.id, id), eq(planSession.userId, userId)));
  if (!row) throw notFound();
  return row;
}

/** The paces a session's zones read: its plan's, or the active plan's for a custom workout. */
async function pacesFor(
  row: PlanSessionRow,
  active: { id: string; paces: PlanPaces } | null,
): Promise<PlanPaces> {
  if (row.planId === null || row.planId === active?.id) {
    if (!active) throw planMissing();
    return active.paces;
  }
  const [own] = await db.select({ paces: plan.paces }).from(plan).where(eq(plan.id, row.planId));
  if (!own) throw new Error(`Session ${row.id} has no plan`);
  return own.paces;
}

async function detail(
  userId: string,
  row: PlanSessionRow,
  now: Date,
): Promise<SessionDetailResponse> {
  const [settings, active] = await Promise.all([settingsOf(userId), activePlanOf(userId)]);
  const paces = await pacesFor(row, active);
  return {
    session: toPlanSession(row, paces, settings.units),
    paces,
    garmin: await readPushStatus(userId, now),
  };
}

/** GET /api/sessions/:id: the runner's session with the paces its zones read and the push status. */
export async function getSession(
  userId: string,
  id: string,
  now = new Date(),
): Promise<SessionDetailResponse> {
  return detail(userId, await ownSession(userId, id), now);
}

/**
 * Refuses a change to a session the runner can no longer change: another plan version's, one that is not
 * planned or moved, or one dated before today.
 */
function assertChangeable(row: PlanSessionRow, activePlanId: string | null, today: string): void {
  if (row.planId !== null && row.planId !== activePlanId) {
    throw locked("This session belongs to an earlier version of your plan.");
  }
  if (!CHANGEABLE.includes(row.status)) {
    throw locked(`This session is ${row.status} and can no longer change.`);
  }
  if (row.date < today) throw locked("This session is in the past and can no longer change.");
}

/** Writes a change only while the session is still planned or moved, so a concurrent change wins once. */
async function updateChangeable(
  userId: string,
  id: string,
  set: Partial<typeof planSession.$inferInsert>,
): Promise<PlanSessionRow> {
  const [row] = await db
    .update(planSession)
    .set(set)
    .where(
      and(
        eq(planSession.id, id),
        eq(planSession.userId, userId),
        inArray(planSession.status, [...CHANGEABLE]),
      ),
    )
    .returning();
  if (!row) throw locked("This session changed meanwhile. Refresh and try again.");
  return row;
}

function customColumns(input: CustomSessionInput, paces: PlanPaces) {
  return {
    date: input.date,
    type: input.type,
    title: input.title,
    steps: input.steps,
    target: sessionTarget(input.steps, paces),
  };
}

/**
 * POST /api/sessions: a custom workout on a date from today on, at the active plan's paces (409
 * plan_missing without one). It belongs to the runner, not to the plan, so a new plan version keeps it.
 */
export async function createCustomSession(
  userId: string,
  input: CustomSessionInput,
  now = new Date(),
): Promise<SessionDetailResponse> {
  const settings = await settingsOf(userId);
  const today = localDateOf(now, settings.timezone);
  if (input.date < today) {
    throw new DomainError(ErrorCode.validation, 400, "Pick today or a later day.", {
      issues: [{ path: "date", message: "The date is before today." }],
    });
  }
  const active = await activePlanOf(userId);
  if (!active) throw planMissing();
  const [row] = await db
    .insert(planSession)
    .values({
      userId,
      planId: null,
      phase: null,
      status: "planned",
      ...customColumns(input, active.paces),
    })
    .returning();
  if (!row) throw new Error("The session insert returned nothing");
  await queueWorkoutPush(userId);
  return detail(userId, row, now);
}

/**
 * PUT /api/sessions/:id: replaces a custom workout's date, type, title and steps. Plan sessions keep the
 * engine's steps (409 session_locked); so does a custom workout that is past, done, missed or skipped, or
 * a move to before today.
 */
export async function updateCustomSession(
  userId: string,
  id: string,
  input: CustomSessionInput,
  now = new Date(),
): Promise<SessionDetailResponse> {
  const row = await ownSession(userId, id);
  const settings = await settingsOf(userId);
  const today = localDateOf(now, settings.timezone);
  if (row.planId !== null) throw locked("A plan session's steps come from the plan.");
  const active = await activePlanOf(userId);
  assertChangeable(row, active?.id ?? null, today);
  if (input.date < today) throw locked("A workout cannot move to a day before today.");
  if (!active) throw planMissing();
  const updated = await updateChangeable(userId, id, customColumns(input, active.paces));
  await queueWorkoutPush(userId);
  return detail(userId, updated, now);
}

/** The hard session the moved one now sits within 48 h of, among the runner's other sessions. */
async function spacingWarning(
  userId: string,
  row: PlanSessionRow,
  date: string,
  activePlanId: string | null,
): Promise<MoveWarning | null> {
  const neighbours = await db
    .select({ type: planSession.type, date: planSession.date })
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        ne(planSession.id, row.id),
        // Skipped and missed sessions were not run, so they put no load on the legs.
        notInArray(planSession.status, ["skipped", "missed"]),
        gte(planSession.date, addDays(date, -HARD_DAY_MIN_GAP_DAYS)),
        lte(planSession.date, addDays(date, HARD_DAY_MIN_GAP_DAYS)),
        activePlanId === null
          ? isNull(planSession.planId)
          : or(isNull(planSession.planId), eq(planSession.planId, activePlanId)),
      ),
    );
  const other = hardSessionTooClose({ type: row.type, date, others: neighbours });
  return other === null
    ? null
    : { code: "hard_days_close", otherType: other.type, otherDate: other.date };
}

/**
 * POST /api/sessions/:id/move: another day of the session's Monday-to-Sunday week, from today on (409
 * session_locked otherwise, as for a session that cannot change). The move is the runner's call: it is
 * never refused for its spacing, only answered with a warning when it leaves two hard sessions within 48 h.
 */
export async function moveSession(
  userId: string,
  id: string,
  date: string,
  now = new Date(),
): Promise<MoveSessionResponse> {
  const row = await ownSession(userId, id);
  const settings = await settingsOf(userId);
  const today = localDateOf(now, settings.timezone);
  const active = await activePlanOf(userId);
  assertChangeable(row, active?.id ?? null, today);
  if (mondayOf(date) !== mondayOf(row.date)) {
    throw locked("A session moves within its own week, Monday to Sunday.");
  }
  if (date < today) throw locked("A session cannot move to a day before today.");
  const warning = await spacingWarning(userId, row, date, active?.id ?? null);
  if (date === row.date) return { ...(await detail(userId, row, now)), warning };
  const moved = await updateChangeable(userId, id, { date, status: "moved" });
  await queueWorkoutPush(userId);
  return { ...(await detail(userId, moved, now)), warning };
}

/**
 * DELETE /api/sessions/:id: skips a session from today on. It is never made up; a custom workout is
 * hidden from then on. The push takes its workout off Garmin.
 */
export async function skipSession(
  userId: string,
  id: string,
  now = new Date(),
): Promise<SessionDetailResponse> {
  const row = await ownSession(userId, id);
  const settings = await settingsOf(userId);
  const today = localDateOf(now, settings.timezone);
  const active = await activePlanOf(userId);
  assertChangeable(row, active?.id ?? null, today);
  const skipped = await updateChangeable(userId, id, { status: "skipped" });
  await queueWorkoutPush(userId);
  return detail(userId, skipped, now);
}
