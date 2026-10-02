import type { APIRequestContext } from "@playwright/test";
import {
  connectGarminResponseSchema,
  meResponseSchema,
  syncResponseSchema,
  type MeResponse,
  type SyncResponse,
  type UpdateSettingsRequest,
} from "@running-coach/shared";
import pg from "pg";

/**
 * The fictional runner every flow and screenshot runs as. playwright.config.ts passes these to the API as
 * OWNER_*, and its boot seeds the owner account from them. Invented on purpose: the repo and its
 * screenshots are public.
 */
export const runner = {
  name: "Jamie Example",
  email: "jamie@example.com",
  password: "e2e-only-password-1",
} as const;

export type Runner = typeof runner;

/** The database the e2e API runs on; playwright.config.ts hands the same URL to the API it starts. */
export const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5434/running_coach_e2e";

/** What a new account starts with (created with the account); every test starts from them. */
export const defaultSettings = {
  units: "km",
  timezone: "UTC",
  coachDetail: "standard",
} as const satisfies Required<UpdateSettingsRequest>;

/**
 * The fixture Garmin's plain login (services/garmin/garmin_service/fake_client.py): no "fixture" key, so
 * every call succeeds, as the account "Alex Fixture".
 */
const fixtureTokenBundle = JSON.stringify({
  di_token: "fixture-token",
  di_refresh_token: "fixture-refresh",
  di_client_id: "fixture-client",
});

/**
 * Where every seeded sync resumes from. A first sync reads only the last 30 days, which loses the fixture
 * runs (2026-08-31 to 2026-09-27) after about 2026-10-27; from this cursor a sync always reads from
 * 2026-09-25 and finds the 18 km run of 2026-09-27, whatever the date.
 */
const pinnedLastSyncAt = "2026-09-26T12:00:00Z";

const runnerId = `(select id from "user" where email = $1)`;

/**
 * Seeds what the API has no route for, on a connection of its own that closes at once: the suite runs one
 * test at a time, so nothing needs a pool or stays open after a worker ends.
 */
async function withDatabase<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Every test starts from "no runs, Garmin not connected, default settings": the runner's runs and Garmin
 * connection are deleted first, then the settings go back to the defaults through the API, the way the app
 * changes them, so the MeResponse returned already shows the reset state.
 */
export async function resetRunner(request: APIRequestContext): Promise<MeResponse> {
  await withDatabase(async (db) => {
    await db.query(`delete from activity where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from garmin_connection where user_id = ${runnerId}`, [runner.email]);
  });
  const response = await request.patch("/api/me/settings", { data: defaultSettings });
  if (!response.ok()) {
    throw new Error(`Resetting the runner's settings failed with ${response.status()}`);
  }
  return meResponseSchema.parse(await response.json());
}

/**
 * Connects the fixture Garmin account through the API, as `pnpm garmin:connect` does, then pins the sync
 * cursor (see pinnedLastSyncAt) with the one statement no route offers. One Garmin login: the API allows
 * six connects a minute per user, so a test connects at most once.
 */
export async function connectGarmin(request: APIRequestContext): Promise<void> {
  const response = await request.put("/api/garmin/connection", {
    data: { tokenBundle: fixtureTokenBundle },
  });
  if (!response.ok()) {
    throw new Error(`Connecting the fixture Garmin account failed with ${response.status()}`);
  }
  connectGarminResponseSchema.parse(await response.json());

  const pinned = await withDatabase((db) =>
    db.query(`update garmin_connection set last_sync_at = $2 where user_id = ${runnerId}`, [
      runner.email,
      pinnedLastSyncAt,
    ]),
  );
  if (pinned.rowCount !== 1) {
    throw new Error("Pinning the sync cursor found no Garmin connection for the runner");
  }
}

/**
 * Sync now through the API, not the UI, for a test that needs the fixture runs stored before it starts.
 * Connect first. The API allows six syncs a minute per user, the whole suite included.
 */
export async function syncGarmin(request: APIRequestContext): Promise<SyncResponse> {
  const response = await request.post("/api/sync");
  if (!response.ok()) {
    throw new Error(`Syncing the fixture Garmin account failed with ${response.status()}`);
  }
  return syncResponseSchema.parse(await response.json());
}

/**
 * Stores the fixture's 18 km run of 2026-09-27 directly, as a sync stores it (same Garmin id, so a later
 * sync updates this row), for tests that need a run on screen without spending a Garmin login.
 */
export async function seedLongRun(): Promise<void> {
  await withDatabase((db) =>
    db.query(
      `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
         duration_s, avg_hr, max_hr, cadence, calories, elevation_gain_m)
       values (${runnerId}, 10000000007, 'running', '2026-09-27T06:00:00Z', '2026-09-27 08:00:00', 18000,
         6120, 148, 166, 168, 1150, 142)`,
      [runner.email],
    ),
  );
}
