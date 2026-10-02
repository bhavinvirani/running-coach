import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { inject, vi } from "vitest";
import { auth } from "../src/auth/auth";
import { db } from "../src/db/client";
import { activity, garminConnection, userSettings } from "../src/db/schema";
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
    | "rotate_then_unavailable",
): string {
  return JSON.stringify({
    di_token: "fixture-token",
    di_refresh_token: "fixture-refresh",
    di_client_id: "fixture-client",
    ...(fixture ? { fixture } : {}),
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

export async function connectGarmin(userId: string, bundle = garminBundle()): Promise<void> {
  await db.insert(garminConnection).values({ userId, tokenBundleEnc: encrypt(bundle, userId) });
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
    })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}
