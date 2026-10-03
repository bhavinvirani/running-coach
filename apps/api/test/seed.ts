import { randomBytes } from "node:crypto";
import { BEST_EFFORTS_VERSION, sessionTarget } from "@running-coach/engine";
import {
  type DistanceKey,
  type PlanPaces,
  planGenerationInputSchema,
  planPacesSchema,
  type SessionSteps,
  sessionStepsSchema,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { inject, vi } from "vitest";
import { auth } from "../src/auth/auth";
import { db } from "../src/db/client";
import {
  activity,
  bestEffort,
  garminConnection,
  goal,
  type ImportProgressRow,
  importProgress,
  type NewPlanRow,
  type NewPlanSessionRow,
  plan,
  planSession,
  type PlanSessionRow,
  userSettings,
} from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";

// Fictional rows for integration tests. Bundles and keys steer the two fakes (global-setup.ts).

/** The fixture service's base bundle; `fixture` picks its behaviour (see services/garmin fake_client.py). */
export function garminBundle(
  fixture?:
    | "expired"
    | "rate_limited"
    | "unavailable"
    | "rotate"
    | "rotated"
    | "rotate_then_rate_limited"
    | "rotate_then_unavailable"
    | "workout_outage"
    | "workout_schedule_outage"
    | "workout_rate_limited",
): string {
  return JSON.stringify({
    di_token: "fixture-token",
    di_refresh_token: "fixture-refresh",
    di_client_id: "fixture-client",
    ...(fixture ? { fixture } : {}),
  });
}

/**
 * Watches the bodies sent to the Garmin service on `path` while letting them through; the returned function
 * lists them parsed, oldest first, the token bundle replaced by its fixture name.
 */
export function bodiesSentTo<T = Record<string, unknown>>(
  path: string,
): () => (Omit<T, "tokenBundle"> & { fixture: string | undefined })[] {
  const spy = vi.spyOn(globalThis, "fetch");
  return () =>
    spy.mock.calls
      .filter(([input]) => href(input).endsWith(path))
      .map(([, init]) => {
        const { tokenBundle, ...body } = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as T & { tokenBundle?: string };
        return { ...(body as Omit<T, "tokenBundle">), fixture: fixtureOf(tokenBundle) };
      });
}

/** The behaviour a fixture bundle names, or undefined for the base bundle. */
export function fixtureOf(bundle: string | undefined): string | undefined {
  return (JSON.parse(bundle ?? "{}") as { fixture?: string }).fixture;
}

function href(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * Watches calls to the Garmin service on `path` while letting them through; the returned function lists
 * the fixture of every bundle sent so far, retries included, oldest first.
 */
export function fixturesSentTo(path: string): () => (string | undefined)[] {
  const spy = vi.spyOn(globalThis, "fetch");
  return () =>
    spy.mock.calls
      .filter(([input]) => href(input).endsWith(path))
      .map(([, init]) => {
        const body = typeof init?.body === "string" ? init.body : "{}";
        return fixtureOf((JSON.parse(body) as { tokenBundle?: string }).tokenBundle);
      });
}

/** A Claude key the fake answers with test/fixtures/claude/<fixture>.json; unique per call. */
export function claudeKey(fixture: string): string {
  return `test-${fixture}.${randomBytes(6).toString("hex")}`;
}

/** What the fake Claude received for a key, oldest first. */
export async function claudeRequests(
  key: string,
): Promise<{ headers: Record<string, unknown>; body: Record<string, unknown> }[]> {
  const response = await fetch(`${inject("claudeBaseUrl")}/__requests/${encodeURIComponent(key)}`);
  return (await response.json()) as {
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }[];
}

/**
 * Creates a user through Better Auth, as production does, so its user.create.after hook adds the default
 * settings row (km, UTC, standard) and tests cannot drift from that.
 */
export async function createUser(email = "runner@example.com"): Promise<string> {
  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser(
    { email, name: "Test Runner" },
    { method: "email-password" },
  );
  return created.id;
}

/**
 * `values` sets the rest of the row, such as a lastSyncAt that keeps a sync's window on the fixture runs
 * (2026-08-31 to 2026-09-27) whatever today's date.
 */
export async function connectGarmin(
  userId: string,
  bundle = garminBundle(),
  values: Partial<
    Pick<typeof garminConnection.$inferInsert, "status" | "lastSyncAt" | "lastError">
  > = {},
): Promise<void> {
  await db
    .insert(garminConnection)
    .values({ userId, tokenBundleEnc: encrypt(bundle, userId), ...values });
}

/**
 * Replaces the stored bundle, which picks the fixture service's behaviour from the next call on. The write
 * moves updated_at, which marks a 429's hour; `updatedAt` places it instead.
 */
export async function setGarminBundle(
  userId: string,
  bundle: string,
  updatedAt?: Date,
): Promise<void> {
  await db
    .update(garminConnection)
    .set({ tokenBundleEnc: encrypt(bundle, userId), ...(updatedAt ? { updatedAt } : {}) })
    .where(eq(garminConnection.userId, userId));
}

/**
 * The fixture account as the Garmin service's get_activities lists it (services/garmin tests/fixtures,
 * sync.json then history.json): 49 items newest first, 46 runs and three other sports.
 */
export const FIXTURE_ACCOUNT = {
  listed: 49,
  runs: 46,
  /** A walk, a ride and a strength session. */
  nonRunIds: [9_000_000_040, 9_000_000_031, 9_000_000_017],
  oldestRunDate: "2023-09-17",
} as const;

/** The user's import_progress row, written over: a running import at offset 0 begun now by default. */
export async function seedImport(
  userId: string,
  values: Partial<Omit<typeof importProgress.$inferInsert, "userId">> = {},
): Promise<ImportProgressRow> {
  const row = { status: "running" as const, startedAt: new Date(), nextOffset: 0, ...values };
  const [stored] = await db
    .insert(importProgress)
    .values({ userId, ...row })
    .onConflictDoUpdate({
      target: importProgress.userId,
      set: {
        cursorDate: null,
        lastError: null,
        resumeAt: null,
        finishedAt: null,
        ...row,
      },
    })
    .returning();
  if (!stored) throw new Error("insert returned nothing");
  return stored;
}

/** The user's import_progress row. */
export async function storedImport(userId: string): Promise<ImportProgressRow> {
  const [row] = await db.select().from(importProgress).where(eq(importProgress.userId, userId));
  if (!row) throw new Error("no import_progress row");
  return row;
}

/** Changes the settings row createUser made; `claudeKey` is stored encrypted. */
export async function setSettings(
  userId: string,
  values: Partial<Omit<typeof userSettings.$inferInsert, "userId">> & { claudeKey?: string },
): Promise<void> {
  const { claudeKey: key, ...rest } = values;
  const [row] = await db
    .update(userSettings)
    .set({ ...rest, ...(key ? { claudeKeyEnc: encrypt(key, userId) } : {}) })
    .where(eq(userSettings.userId, userId))
    .returning({ userId: userSettings.userId });
  if (!row) throw new Error("the user has no settings row");
}

/**
 * A run of the user's with the values a test names: by default an outdoor 10 km on 2026-09-27 under the
 * fixture account's long-run id, for which the fixture service serves its detail samples.
 */
export async function createRun(
  userId: string,
  values: Partial<Omit<typeof activity.$inferInsert, "userId">> = {},
) {
  const [row] = await db
    .insert(activity)
    .values({
      userId,
      garminActivityId: 10_000_000_007,
      type: "running",
      startUtc: new Date("2026-09-27T06:00:00Z"),
      startLocal: "2026-09-27 08:00:00",
      distanceM: 10_000,
      durationS: 3000,
      ...values,
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/** The fixture service's 18 km long run of 2026-09-27, as the sync stores it. */
export async function createLongRun(userId: string, garminActivityId = 10_000_000_007) {
  const [row] = await db
    .insert(activity)
    .values({
      userId,
      garminActivityId,
      type: "running",
      startUtc: new Date("2026-09-27T06:00:00Z"),
      startLocal: "2026-09-27 08:00:00",
      distanceM: 18_000,
      durationS: 6120,
      avgHr: 148,
      maxHr: 166,
      cadence: 168,
      calories: 1150,
      elevationGainM: 142,
      eventType: "uncategorized",
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

let lastGarminActivityId = 0;

/** A Garmin activity id no other run seeded in the test file has; the fixture account's ids are far above. */
export function nextGarminActivityId(): number {
  lastGarminActivityId += 1;
  return lastGarminActivityId;
}

/**
 * A run on a local date, 08:00 there, with its own Garmin id. Its UTC start reads the wall clock as UTC:
 * every reader of a run's date uses start_local.
 */
export async function createRunOn(
  userId: string,
  date: string,
  values: Partial<Omit<typeof activity.$inferInsert, "userId">> = {},
) {
  return createRun(userId, {
    garminActivityId: nextGarminActivityId(),
    startUtc: new Date(`${date}T08:00:00Z`),
    startLocal: `${date} 08:00:00`,
    ...values,
  });
}

/** A run whose best efforts are stored at the current rule: one row per distance with the times given. */
export async function createComputedRun(
  userId: string,
  efforts: Partial<Record<DistanceKey, number>>,
  values: Partial<Omit<typeof activity.$inferInsert, "userId">> = {},
) {
  const run = await createRun(userId, {
    garminActivityId: nextGarminActivityId(),
    bestEffortsVersion: BEST_EFFORTS_VERSION,
    ...values,
  });
  const rows = Object.entries(efforts).map(([distanceKey, timeS]) => ({
    userId,
    activityId: run.id,
    distanceKey: distanceKey as DistanceKey,
    timeS,
    startS: 12.5,
  }));
  if (rows.length > 0) await db.insert(bestEffort).values(rows);
  return run;
}

/** A plan's paces (VDOT about 47.6), parsed so they cannot drift from the contract. */
export const PACES: PlanPaces = planPacesSchema.parse({
  easy: { fastSPerKm: 300, slowSPerKm: 336 },
  marathon: { fastSPerKm: 262, slowSPerKm: 268 },
  threshold: { fastSPerKm: 247, slowSPerKm: 253 },
  interval: { fastSPerKm: 227, slowSPerKm: 231 },
  repetition: { fastSPerKm: 211, slowSPerKm: 215 },
  race: { fastSPerKm: 256, slowSPerKm: 260 },
});

/** Another runner's paces, as a new plan version after a better race would have. */
export const FASTER_PACES: PlanPaces = planPacesSchema.parse({
  easy: { fastSPerKm: 290, slowSPerKm: 325 },
  marathon: { fastSPerKm: 252, slowSPerKm: 258 },
  threshold: { fastSPerKm: 238, slowSPerKm: 244 },
  interval: { fastSPerKm: 218, slowSPerKm: 222 },
  repetition: { fastSPerKm: 203, slowSPerKm: 207 },
  race: { fastSPerKm: 246, slowSPerKm: 250 },
});

export const EASY_STEPS: SessionSteps = sessionStepsSchema.parse([
  { kind: "run", zone: "easy", distanceM: 8000, durationS: null },
]);

export const TEMPO_STEPS: SessionSteps = sessionStepsSchema.parse([
  { kind: "warmup", zone: "easy", distanceM: 2000, durationS: null },
  { kind: "run", zone: "threshold", distanceM: null, durationS: 1200 },
  { kind: "cooldown", zone: "easy", distanceM: 2000, durationS: null },
]);

export const INTERVAL_STEPS: SessionSteps = sessionStepsSchema.parse([
  { kind: "warmup", zone: "easy", distanceM: 2000, durationS: null },
  {
    repeat: 5,
    steps: [
      { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
      { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
    ],
  },
  { kind: "cooldown", zone: "easy", distanceM: 2000, durationS: null },
]);

const PLAN_INPUTS = planGenerationInputSchema.parse({
  goal: {
    kind: "fitness",
    distanceKey: null,
    raceDate: null,
    targetTimeS: null,
    daysPerWeek: 4,
    longRunDay: "sun",
    recentTime: { distanceKey: "10k", timeS: 2700 },
  },
  startDate: "2026-09-28",
  baseline: {
    weeklyVolumesM: [30_000, 30_000, 30_000, 30_000],
    longestRunM: 15_000,
    daysSinceLastRun: 2,
  },
  vdotSource: { origin: "entered", distanceM: 10_000, timeS: 2700, activityId: null, date: null },
});

/**
 * A plan of the user's, active by default, written directly so a test chooses every session: a fitness
 * goal (made once per user) and a plan spanning 2026-09-28 to 2026-12-20 unless `values` say otherwise.
 */
export async function createPlan(userId: string, values: Partial<NewPlanRow> = {}) {
  await db
    .insert(goal)
    .values({ userId, kind: "fitness", daysPerWeek: 4, longRunDay: "sun" })
    .onConflictDoNothing({ target: goal.userId });
  const [goalRow] = await db.select({ id: goal.id }).from(goal).where(eq(goal.userId, userId));
  const [row] = await db
    .insert(plan)
    .values({
      goalId: goalRow!.id,
      userId,
      version: 1,
      engineVersion: "test",
      status: "active",
      startDate: "2026-09-28",
      endDate: "2026-12-20",
      vdot: 47.6,
      vdotSource: PLAN_INPUTS.vdotSource!,
      paces: PACES,
      inputs: PLAN_INPUTS,
      warnings: [],
      ...values,
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/**
 * A session of the plan (phase base), or a custom workout with `planId: null` (no phase): an easy 8 km by
 * default, its target from its steps at PACES.
 */
export async function createSession(
  userId: string,
  planId: string | null,
  values: Partial<Omit<NewPlanSessionRow, "userId" | "planId">> & { date: string },
): Promise<PlanSessionRow> {
  const steps = values.steps ?? EASY_STEPS;
  const [row] = await db
    .insert(planSession)
    .values({
      userId,
      planId,
      phase: planId === null ? null : "base",
      type: "easy",
      target: sessionTarget(steps, PACES),
      ...values,
      steps,
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/** The session row as stored now. */
export async function storedSession(id: string): Promise<PlanSessionRow> {
  const [row] = await db.select().from(planSession).where(eq(planSession.id, id));
  if (!row) throw new Error(`no session ${id}`);
  return row;
}
