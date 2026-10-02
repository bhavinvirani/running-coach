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
 * Every test starts from "no runs, no history import, Garmin not connected, default settings": the
 * runner's runs, import progress and Garmin connection are deleted first, then the settings go back to the
 * defaults through the API, the way the app changes them, so the MeResponse returned already shows the
 * reset state. An import page job left queued by an earlier test finds no progress row and does nothing.
 */
export async function resetRunner(request: APIRequestContext): Promise<MeResponse> {
  await withDatabase(async (db) => {
    await db.query(`delete from activity where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from import_progress where user_id = ${runnerId}`, [runner.email]);
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

type SeededRun = {
  /** Wall-clock start where the runner ran, Berlin summer time (UTC+2). */
  startLocal: string;
  distanceM: number;
  durationS: number;
  indoor?: boolean;
  manual?: boolean;
};

/**
 * Ten weeks of a fictional 10K build, newest first: 24 runs from Wed 22 Jul to Sun 27 Sep 2026, every week
 * from 20–26 Jul to 21–27 Sep with two or three runs. Progress shows the eight newest weeks (21–27 Sep back
 * to 3–9 Aug) and Show earlier weeks the last two. Week totals in km, newest first: 30, 27, 24, 20, 22, 20,
 * 18, 16, then 15 and 12. The treadmill run of Thu 24 Sep is indoor, the run of Thu 17 Sep entered by hand.
 */
export const runHistory: readonly SeededRun[] = [
  // 21–27 Sep: 30.0 km, 2:49:00
  { startLocal: "2026-09-27T08:00:00", distanceM: 16_000, durationS: 5520 },
  { startLocal: "2026-09-24T18:45:00", distanceM: 6000, durationS: 1980, indoor: true },
  { startLocal: "2026-09-22T18:30:00", distanceM: 8000, durationS: 2640 },
  // 14–20 Sep: 27.0 km
  { startLocal: "2026-09-20T08:00:00", distanceM: 14_000, durationS: 4830 },
  { startLocal: "2026-09-17T07:00:00", distanceM: 5000, durationS: 1800, manual: true },
  { startLocal: "2026-09-15T18:30:00", distanceM: 8000, durationS: 2640 },
  // 7–13 Sep: 24.0 km
  { startLocal: "2026-09-13T08:00:00", distanceM: 12_000, durationS: 4140 },
  { startLocal: "2026-09-10T18:30:00", distanceM: 5000, durationS: 1650 },
  { startLocal: "2026-09-08T18:30:00", distanceM: 7000, durationS: 2310 },
  // 31 Aug – 6 Sep: 20.0 km
  { startLocal: "2026-09-06T08:00:00", distanceM: 13_000, durationS: 4485 },
  { startLocal: "2026-09-02T18:30:00", distanceM: 7000, durationS: 2310 },
  // 24–30 Aug: 22.0 km
  { startLocal: "2026-08-30T08:00:00", distanceM: 12_000, durationS: 4140 },
  { startLocal: "2026-08-27T18:30:00", distanceM: 4000, durationS: 1320 },
  { startLocal: "2026-08-25T18:30:00", distanceM: 6000, durationS: 1980 },
  // 17–23 Aug: 20.0 km
  { startLocal: "2026-08-23T08:00:00", distanceM: 11_000, durationS: 3795 },
  { startLocal: "2026-08-19T18:30:00", distanceM: 9000, durationS: 2970 },
  // 10–16 Aug: 18.0 km
  { startLocal: "2026-08-16T08:00:00", distanceM: 10_000, durationS: 3450 },
  { startLocal: "2026-08-12T18:30:00", distanceM: 8000, durationS: 2640 },
  // 3–9 Aug: 16.0 km
  { startLocal: "2026-08-09T08:00:00", distanceM: 10_000, durationS: 3450 },
  { startLocal: "2026-08-05T18:30:00", distanceM: 6000, durationS: 1980 },
  // 27 Jul – 2 Aug: 15.0 km
  { startLocal: "2026-08-02T08:00:00", distanceM: 9000, durationS: 3105 },
  { startLocal: "2026-07-29T18:30:00", distanceM: 6000, durationS: 1980 },
  // 20–26 Jul: 12.0 km
  { startLocal: "2026-07-26T08:00:00", distanceM: 8000, durationS: 2760 },
  { startLocal: "2026-07-22T18:30:00", distanceM: 4000, durationS: 1320 },
];

/** Garmin ids grow over time; these sit far from the fixture account's, so a sync never touches them. */
const firstHistoryGarminId = 20_000_000_001;

/** Stores runHistory as an import would, in one statement. */
export async function seedRunHistory(): Promise<void> {
  const oldestFirst = [...runHistory].reverse();
  await withDatabase((db) =>
    db.query(
      `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
         duration_s, is_indoor, is_manual)
       select ${runnerId}, run.garmin_id, run.type, run.start_local at time zone 'Europe/Berlin',
         run.start_local, run.distance_m, run.duration_s, run.indoor, run.manual
       from unnest($2::bigint[], $3::text[], $4::timestamp[], $5::float8[], $6::float8[], $7::bool[],
         $8::bool[]) as run(garmin_id, type, start_local, distance_m, duration_s, indoor, manual)`,
      [
        runner.email,
        oldestFirst.map((_, index) => firstHistoryGarminId + index),
        oldestFirst.map((run) => (run.indoor ? "treadmill_running" : "running")),
        oldestFirst.map((run) => run.startLocal),
        oldestFirst.map((run) => run.distanceM),
        oldestFirst.map((run) => run.durationS),
        oldestFirst.map((run) => run.indoor ?? false),
        oldestFirst.map((run) => run.manual ?? false),
      ],
    ),
  );
}

/**
 * An import_progress row in a fixed state, for screens that show the import line without running one. Every
 * time is fixed, so the line reads the same whatever the date.
 */
export type SeededImport =
  | {
      status: "done";
      startedAt: string;
      finishedAt: string;
      /** Local date of the oldest run reached. */
      oldestDate: string;
      nextOffset: number;
    }
  | {
      status: "paused";
      startedAt: string;
      /** When the paused page runs; keep it in the future, or the API reads the import as stalled. */
      resumeAt: string;
      oldestDate: string | null;
      nextOffset: number;
    };

/** runHistory imported in full on Mon 28 Sep 2026. */
export const importDone = {
  status: "done",
  startedAt: "2026-09-28T06:00:00Z",
  finishedAt: "2026-09-28T06:01:30Z",
  oldestDate: "2026-07-22",
  nextOffset: runHistory.length,
} as const satisfies SeededImport;

/**
 * A first import stopped by Garmin's 429 before any page. It continues at 14:05 UTC on a winter day years
 * ahead (no DST change near it), so it is paused, never stalled, whenever the suite runs.
 */
export const importPaused = {
  status: "paused",
  startedAt: "2026-09-28T06:00:00Z",
  resumeAt: "2036-01-15T14:05:00Z",
  oldestDate: null,
  nextOffset: 0,
} as const satisfies SeededImport;

/** Writes the runner's import_progress row as the import would have left it; queues no page. */
export async function seedImportProgress(progress: SeededImport): Promise<void> {
  const finishedAt = progress.status === "done" ? progress.finishedAt : null;
  const resumeAt = progress.status === "paused" ? progress.resumeAt : null;
  const lastError = progress.status === "paused" ? "garmin_rate_limited" : null;
  await withDatabase((db) =>
    db.query(
      `insert into import_progress (user_id, status, next_offset, cursor_date, last_error, resume_at,
         started_at, finished_at)
       values (${runnerId}, $2, $3, $4, $5, $6, $7, $8)`,
      [
        runner.email,
        progress.status,
        progress.nextOffset,
        progress.oldestDate,
        lastError,
        resumeAt,
        progress.startedAt,
        finishedAt,
      ],
    ),
  );
}
