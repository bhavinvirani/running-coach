import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";
import {
  WALK_RUN_TITLE,
  applyDelta,
  garminWorkout,
  generatePlan,
  reEntryPlan,
  type AdjustedSession,
} from "@running-coach/engine";
import {
  ErrorCode,
  RACE_EVENT_TYPE,
  connectGarminResponseSchema,
  garminWorkoutName,
  meResponseSchema,
  personalBestsResponseSchema,
  syncResponseSchema,
  type CoachFallbackReason,
  type CoachFeedback,
  type DistanceKey,
  type GeneratedPlan,
  type MeResponse,
  type OtherGarminWorkout,
  type PlanGenerationInput,
  type PlanPaces,
  type PlanPhase,
  type RecentTime,
  type RunInsight,
  type SessionStatus,
  type SessionSteps,
  type SessionTarget,
  type SessionType,
  type SyncResponse,
  type UpdateSettingsRequest,
} from "@running-coach/shared";
import pg from "pg";
import { addDays, today, weekStart } from "../../src/lib/dates";
import { e2eSlot } from "./slot";

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

/**
 * The database the e2e API runs on, this folder's slot's; playwright.config.ts hands the same URL to the API
 * it starts, after e2e/reset-database.ts recreates it. The slot is the only setting, so a reset can never
 * follow an override to another database.
 */
export const e2eDatabaseUrl = `postgres://postgres:postgres@localhost:5434/${e2eSlot.database}`;

/**
 * The e2e API's MASTER_KEY (playwright.config.ts): a fake value for e2e only, here so seeded secrets are
 * encrypted the way that API decrypts them.
 */
export const e2eMasterKey = "ZTJlLW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcy1vayE=";

/**
 * The fake Claude playwright.config.ts starts beside the API (apps/api/test/fake-claude-cli.ts) and points
 * its CLAUDE_BASE_URL at: it replays apps/api/test/fixtures/claude and never reaches Anthropic. Its port is
 * this folder's slot's.
 */
export const fakeClaudePort = e2eSlot.fakeClaudePort;
export const fakeClaudeUrl = `http://127.0.0.1:${fakeClaudePort}`;

/** What a new account starts with (created with the account); every test starts from them. */
export const defaultSettings = {
  units: "km",
  timezone: "UTC",
  coachDetail: "standard",
  coachCredential: "key",
} as const satisfies Required<UpdateSettingsRequest>;

/**
 * The runner's local date now, in the zone every test starts with: the API's today, which decides the days
 * it keeps on Garmin, and the browser's under playwright.config.ts's zone and the real clock.
 */
export function runnerToday(): string {
  return today(defaultSettings.timezone);
}

/**
 * The fixture Garmin's logins (services/garmin/garmin_service/fake_client.py), as the account "Alex
 * Fixture": "plain" has no "fixture" key, so every call succeeds; "workout_outage" fails the second upload
 * of every workout push with a 503, so the first workout goes and the push stops at the second.
 */
export type FixtureLogin = "plain" | "workout_outage";

function fixtureTokenBundle(login: FixtureLogin): string {
  return JSON.stringify({
    di_token: "fixture-token",
    di_refresh_token: "fixture-refresh",
    di_client_id: "fixture-client",
    ...(login === "plain" ? {} : { fixture: login }),
  });
}

/**
 * Where every seeded sync resumes from. A first sync reads only the last 30 days, which loses the fixture
 * runs (2026-08-31 to 2026-09-27) after about 2026-10-27; from this cursor a sync always reads from
 * 2026-09-25 and finds the 18 km run of 2026-09-27, whatever the date.
 */
const pinnedLastSyncAt = "2026-09-26T12:00:00Z";

/**
 * A cursor from which a sync reads from 2026-09-06: the fixture's six runs of 6 to 27 Sep, among them the
 * 10.2 km race of Sun 6 Sep, the 8 km treadmill run of Thu 24 Sep and the 6.5 km run without heart rate of
 * Wed 16 Sep.
 */
export const syncFromRaceDay = "2026-09-07T12:00:00Z";

/** Garmin's event type for every fixture run that is not a race (sync.json, history.json). */
const UNCATEGORIZED = "uncategorized";

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

/** The runner's batches on the best-efforts queue (apps/api/src/jobs/best-efforts-queue.ts), keyed by user. */
const runnerBatches = `from pgboss.job where name = 'best-efforts'
  and singleton_key = (select id::text from "user" where email = $1)`;

/**
 * The queue keeps one batch waiting per user and folds every later send into it, and an import queues its
 * next batch 30 s ahead: left over from an earlier test, that batch would take in this test's sync and
 * hold its runs back until it starts. Called once the runs are deleted, so a batch still running finds
 * nothing left to queue a successor for; when none runs, the waiting ones are deleted as pg-boss's
 * deleteJob does. A fixture batch runs in milliseconds.
 */
async function clearBestEffortsBatches(db: pg.Client): Promise<void> {
  await expect
    .poll(
      async () => {
        const { rows } = await db.query<{ running: number }>(
          `select count(*)::int as running ${runnerBatches} and state = 'active'`,
          [runner.email],
        );
        return rows[0]?.running;
      },
      { message: "A best-efforts batch of the runner is still running", timeout: 10_000 },
    )
    .toBe(0);
  await db.query(`delete ${runnerBatches} and state in ('created', 'retry')`, [runner.email]);
}

/** The runner's pushes on the push-workouts queue (apps/api/src/jobs/push-workouts-queue.ts), by user. */
const runnerPushes = `from pgboss.job where name = 'push-workouts'
  and data->>'userId' = (select id::text from "user" where email = $1)`;

/**
 * Leaves no push of the runner queued, running or waiting out a retry. A push left by an earlier test (the
 * workout outage's retry starts 5 min later) or queued by connecting would otherwise write Garmin ids onto
 * this test's sessions whenever it ran, and on a screen pinned to October 2026 it would strip seeded ones,
 * since the API pushes the server's real week. Waiting ones are deleted as pg-boss's deleteJob does; a
 * running one is waited out (a fixture push takes about a second) and deleted if it ends in a retry.
 */
async function clearPushes(db: pg.Client): Promise<void> {
  await expect
    .poll(
      async () => {
        await db.query(`delete ${runnerPushes} and state in ('created', 'retry')`, [runner.email]);
        const { rows } = await db.query<{ pending: number }>(
          `select count(*)::int as pending ${runnerPushes} and state in ('created', 'retry', 'active')`,
          [runner.email],
        );
        return rows[0]?.pending;
      },
      { message: "A workout push of the runner is still running", timeout: 10_000 },
    )
    .toBe(0);
}

/** The runner's coach jobs on the analyze-run queue (apps/api/src/jobs/analyze-run-queue.ts), by user. */
const runnerInsightJobs = `from pgboss.job where name = 'analyze-run'
  and data->>'userId' = (select id::text from "user" where email = $1)`;

/**
 * Every test starts from "no goal or plan, no runs, no coach cards, no history import, Garmin not
 * connected, no Claude key, no pause, default settings": no workout push of the runner is left
 * (clearPushes), coach jobs still waiting are deleted, then the runner's plan changes, pauses, plan
 * sessions, plans, goal, coach cards, runs, import progress, Garmin connection and Claude key are deleted,
 * then the settings go back to the defaults through the API, the way the app changes them, so the
 * MeResponse returned already shows the reset state. An import page job left queued by an earlier test
 * finds no progress row and does nothing; a best-efforts batch left waiting is deleted
 * (clearBestEffortsBatches); a coach job already running finds its run gone and stores nothing.
 */
export async function resetRunner(request: APIRequestContext): Promise<MeResponse> {
  await withDatabase(async (db) => {
    await clearPushes(db);
    await db.query(`delete ${runnerInsightJobs} and state in ('created', 'retry')`, [runner.email]);
    // Changes before their sessions, sessions before their plans, plans before their goal, cards before
    // their runs: each would go with its parent (on delete cascade), but each table is emptied by its own
    // user_id so none is left behind if that ever changes. A rejected coach proposal has no session to go
    // with, and an open pause would hold the next test's sessions.
    await db.query(`delete from plan_adjustment where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from training_pause where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from plan_session where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from plan where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from goal where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from coach_message where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from activity where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from import_progress where user_id = ${runnerId}`, [runner.email]);
    await db.query(`delete from garmin_connection where user_id = ${runnerId}`, [runner.email]);
    await db.query(`update user_settings set claude_key_enc = null where user_id = ${runnerId}`, [
      runner.email,
    ]);
    await clearBestEffortsBatches(db);
  });
  const response = await request.patch("/api/me/settings", { data: defaultSettings });
  if (!response.ok()) {
    throw new Error(`Resetting the runner's settings failed with ${response.status()}`);
  }
  return meResponseSchema.parse(await response.json());
}

/**
 * Each fixture login as the API stored it on this worker's first connect with it: encrypted with the e2e
 * MASTER_KEY for the runner, whose id stays the same for the whole run. The fixture Garmin never rotates
 * these bundles, so each value stays good for every later sync and push.
 */
const storedFixtureLogins = new Map<FixtureLogin, string>();

/**
 * Connects the fixture Garmin account with one of its logins (plain unless the test names another), then
 * pins the sync cursor (pinnedLastSyncAt unless the test names another) with the one statement no route
 * offers. The worker's first connect with a login goes through the API, as `pnpm garmin:connect` does;
 * every later one writes back the row that connect stored (storedFixtureLogins), as a reconnect leaves it:
 * status ok, no last error. One Garmin login per worker keeps the suite quick and every later connect
 * deterministic. The API's connect queues a workout push; it is waited out and deleted, and what it stored
 * cleared, so every connect leaves Garmin connected with nothing pushed and no push queued. Connect before
 * seeding sessions: that push would send any already stored.
 */
export async function connectGarmin(
  request: APIRequestContext,
  lastSyncAt: string = pinnedLastSyncAt,
  login: FixtureLogin = "plain",
): Promise<void> {
  const stored = storedFixtureLogins.get(login);
  if (stored === undefined) {
    const response = await request.put("/api/garmin/connection", {
      data: { tokenBundle: fixtureTokenBundle(login) },
    });
    if (!response.ok()) {
      throw new Error(`Connecting the fixture Garmin account failed with ${response.status()}`);
    }
    connectGarminResponseSchema.parse(await response.json());
  }

  await withDatabase(async (db) => {
    if (stored === undefined) {
      const { rows } = await db.query<{ token_bundle_enc: string }>(
        `select token_bundle_enc from garmin_connection where user_id = ${runnerId}`,
        [runner.email],
      );
      const encrypted = rows[0]?.token_bundle_enc;
      if (encrypted === undefined) {
        throw new Error("The API answered the connect but stored no Garmin connection");
      }
      storedFixtureLogins.set(login, encrypted);
      await clearPushes(db);
      await db.query(
        `update garmin_connection
         set workouts_pushed_at = null, workouts_push_error = null, garmin_calendar = '[]'::jsonb
         where user_id = ${runnerId}`,
        [runner.email],
      );
    } else {
      await db.query(
        `insert into garmin_connection (user_id, token_bundle_enc, status) values (${runnerId}, $2, 'ok')
         on conflict (user_id) do update
         set token_bundle_enc = excluded.token_bundle_enc, status = 'ok', last_error = null`,
        [runner.email, stored],
      );
    }
    const pinned = await db.query(
      `update garmin_connection set last_sync_at = $2 where user_id = ${runnerId}`,
      [runner.email, lastSyncAt],
    );
    if (pinned.rowCount !== 1) {
      throw new Error("Pinning the sync cursor found no Garmin connection for the runner");
    }
  });
}

/**
 * A Garmin login that has expired, as a sync leaves it once Garmin rejects the saved login: status expired,
 * last error garmin_auth_expired, the cursor at pinnedLastSyncAt (Sat 26 Sep 2026, 12:00 UTC). Written
 * directly, so it spends no Garmin login. The token bundle is a stand-in that never decrypts: the API
 * refuses an expired login before it opens the bundle (requireGarminConnection), and nothing else reads it.
 */
export async function seedExpiredGarminLogin(): Promise<void> {
  await withDatabase((db) =>
    db.query(
      `insert into garmin_connection (user_id, token_bundle_enc, status, last_sync_at, last_error)
       values (${runnerId}, 'v1:e2e-expired-login-never-decrypted', 'expired', $2, $3)`,
      [runner.email, pinnedLastSyncAt, ErrorCode.garminAuthExpired],
    ),
  );
}

/** The state a finished workout push leaves on the connection: when it ended and other apps' workouts. */
export type SeededPush = {
  pushedAt: string;
  others: readonly OtherGarminWorkout[];
};

/**
 * A working Garmin login with the state a finished workout push leaves, written straight into the
 * database for screens that show where workouts stand on Garmin. Unlike connectGarmin it queues no push:
 * the API pushes the server's real week, which would strip the ids seeded on a plan pinned to October 2026
 * while the screen is captured. The token bundle is a stand-in that never decrypts, so nothing may call
 * Garmin with it: open the app with skipSyncOnOpen, and tap nothing that pushes. The cursor is
 * pinnedLastSyncAt. The API lists only the others dated in its own week, so a screen showing one seeds
 * it on runnerToday() and masks its day.
 */
export async function seedPushedGarmin({ pushedAt, others }: SeededPush): Promise<void> {
  await withDatabase((db) =>
    db.query(
      `insert into garmin_connection (user_id, token_bundle_enc, status, last_sync_at, workouts_pushed_at,
         garmin_calendar)
       values (${runnerId}, 'v1:e2e-pushed-login-never-decrypted', 'ok', $2, $3, $4::jsonb)`,
      [runner.email, pinnedLastSyncAt, pushedAt, JSON.stringify(others)],
    ),
  );
}

/**
 * Sync now through the API, not the UI, for a test that needs the fixture runs stored before it starts.
 * Connect first.
 */
export async function syncGarmin(request: APIRequestContext): Promise<SyncResponse> {
  const response = await request.post("/api/sync");
  if (!response.ok()) {
    throw new Error(`Syncing the fixture Garmin account failed with ${response.status()}`);
  }
  return syncResponseSchema.parse(await response.json());
}

/**
 * The fake Claude's fixtures (apps/api/test/fixtures/claude) the e2e flows use: "valid" accepts the key and
 * writes the 18 km long run's card; "key-invalid" rejects the key (401).
 */
export type ClaudeFixture = "valid" | "key-invalid";

let fakeKeysMade = 0;

/**
 * A key of the form the fake Claude reads, "test-<fixture>.<nonce>": it answers with that fixture. The
 * nonce differs per key, so each test reads only its own calls from the fake's log (fakeClaudeCalls).
 */
export function fakeClaudeKey(fixture: ClaudeFixture): string {
  fakeKeysMade += 1;
  return `test-${fixture}.e2e-${fakeKeysMade}`;
}

/** apps/api/src/lib/crypto.ts's encrypt with the e2e MASTER_KEY: "v1:" + base64url(iv | text | tag). */
function encryptForUser(plaintext: string, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(e2eMasterKey, "base64"), iv, {
    authTagLength: 16,
  });
  // The user id is the additional data, as the API binds every secret to its owner.
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
}

/**
 * Stores a fake Claude key for the runner, encrypted as PUT /api/me/claude-key stores one, without the
 * check that route makes: a key whose fixture fails (key-invalid, unavailable) can be seeded too, as a key
 * that worked when it was saved. Returns the key, for fakeClaudeCalls.
 */
export async function seedClaudeKey(fixture: ClaudeFixture): Promise<string> {
  const key = fakeClaudeKey(fixture);
  await withDatabase(async (db) => {
    const { rows } = await db.query<{ id: string }>(`select id from "user" where email = $1`, [
      runner.email,
    ]);
    const userId = rows[0]?.id;
    if (userId === undefined) throw new Error("The runner's account does not exist");
    const stored = await db.query(
      "update user_settings set claude_key_enc = $2 where user_id = $1",
      [userId, encryptForUser(key, userId)],
    );
    if (stored.rowCount !== 1) throw new Error("The runner has no settings to store a key on");
  });
  return key;
}

/** The runner's Claude key as the database holds it: encrypted, or null when none is set. */
export async function storedClaudeKey(): Promise<string | null> {
  return withDatabase(async (db) => {
    const { rows } = await db.query<{ claude_key_enc: string | null }>(
      `select claude_key_enc from user_settings where user_id = ${runnerId}`,
      [runner.email],
    );
    return rows[0]?.claude_key_enc ?? null;
  });
}

/**
 * The calls the API made to the fake Claude with this key, oldest first: "models" is the key check on
 * save (GET /v1/models), "messages" a coach card (POST /v1/messages).
 */
export async function fakeClaudeCalls(
  request: APIRequestContext,
  key: string,
  kind: "models" | "messages",
): Promise<unknown[]> {
  const path = `${fakeClaudeUrl}/__requests/${encodeURIComponent(key)}`;
  const response = await request.get(kind === "models" ? `${path}/models` : path);
  if (!response.ok()) throw new Error(`The fake Claude's log answered ${response.status()}`);
  return (await response.json()) as unknown[];
}

/**
 * The plan token playwright.config.ts gives the coach service, which hands it to the fake Claude Code CLI
 * it runs (apps/coach/test/fake-claude-code.mjs): "test-<scenario>.<nonce>", where "success" answers every
 * run with a valid card of fake data, and the nonce names the log the fake appends to (fakeClaudeCodeRuns).
 */
// The nonce names the log in the shared temp directory, so each slot reads its own.
const fakeClaudeCodeNonce = e2eSlot.fakeClaudeCodeNonce;
export const fakeClaudeCodeToken = `test-success.${fakeClaudeCodeNonce}`;

/**
 * How many times the coach service has started the fake Claude Code CLI so far: each process appends a
 * "start" line to its log in the shared temp directory (TMPDIR reaches the coach service and its child
 * from this machine's environment). The log outlives a run, so a test compares counts before and after.
 */
export async function fakeClaudeCodeRuns(): Promise<number> {
  let log: string;
  try {
    log = await readFile(
      path.join(tmpdir(), `fake-claude-code-${fakeClaudeCodeNonce}.jsonl`),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  return log
    .split("\n")
    .filter((line) => line !== "")
    .filter((line) => (JSON.parse(line) as { event?: unknown }).event === "start").length;
}

/**
 * A coach card for seedLongRun's 18 km run with seedRunDetail's outdoor laps and zones, in the coach's
 * voice: what happened, what it means, what to do next, in numbers. Fictional, as every seed.
 */
export const longRunInsight = {
  headline: "18.0 km in 1:42:00 at 5:40 /km, with the last km the fastest at 5:06.",
  whatHappened:
    "Heart rate stayed between 140 and 155 bpm for 16 km. It rose to 158 bpm on the climb at km 10, run at 6:06, and to 165 bpm on the last km.",
  whatItMeans:
    "52 of the 102 minutes were in zone 3. An even pace at a steady heart rate means 18 km is within your aerobic range. The fast last km added load the plan did not ask for.",
  nextStep:
    "Keep the next run easy: 30 to 40 minutes at 6:20 /km or slower. On the next long run, hold the last km at the pace of the rest.",
  caution: "easy_next",
} as const satisfies RunInsight;

/**
 * The fallback card the API builds for seedLongRun's run when Claude does not answer (buildRunInsightFallback
 * in apps/api/src/coach/prompts/run-insight/fallback.ts, reason unavailable, no plan): the run's numbers only.
 */
export const longRunFallbackInsight = {
  headline: "18.0 km in 1:42:00 at 5:40 /km.",
  whatHappened:
    "Average heart rate 148 bpm, max 166 bpm. Cadence 168 steps per minute. Elevation gain 142 m.",
  whatItMeans:
    "No coach review: Claude is not answering right now. These are the run's numbers only.",
  nextStep:
    "Keep your next run easy, or take a rest day. Rest or run easy if anything hurts or you feel unwell.",
  caution: "none",
} as const satisfies RunInsight;

/** When seeded cards were written: two hours after seedLongRun's run ended. Nothing on screen shows it. */
const insightWrittenAt = "2026-09-27T09:42:00Z";

/**
 * Stores a coach card for an already stored run, as the analyze-run job stores it (analyzeRun in
 * apps/api/src/services/insights.ts): the model's card, or with `fallbackReason` the fallback card, which
 * has no model. `feedback` is a thumb the runner already gave. Goes with the run (on delete cascade).
 */
export async function seedInsight(
  garminActivityId: number,
  content: RunInsight,
  {
    fallbackReason = null,
    feedback = null,
  }: { fallbackReason?: CoachFallbackReason | null; feedback?: CoachFeedback | null } = {},
): Promise<void> {
  await withDatabase(async (db) => {
    const inserted = await db.query(
      `insert into coach_message (user_id, kind, activity_id, prompt_version, model, content,
         fallback_reason, feedback, usage, created_at, updated_at)
       select activity.user_id, 'insight', activity.id, 'run-insight/v1', $3, $4::jsonb, $5, $6, $7::jsonb,
         $8, $8
       from activity where activity.user_id = ${runnerId} and activity.garmin_activity_id = $2`,
      [
        runner.email,
        garminActivityId,
        fallbackReason === null ? "claude-opus-5-5" : null,
        JSON.stringify(content),
        fallbackReason,
        feedback,
        fallbackReason === null ? JSON.stringify({ inputTokens: 1180, outputTokens: 164 }) : null,
        insightWrittenAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new Error(`No stored run with Garmin id ${garminActivityId} to add a coach card to`);
    }
  });
}

/** Garmin ids of the fixture account's runs that tests store or open (services/garmin sync.json). */
export const fixtureRunIds = {
  /** 18 km on Sun 27 Sep 2026, 08:00, outdoors, with heart rate. */
  longRun: 10_000_000_007,
  /** 8 km on a treadmill on Thu 24 Sep 2026, 18:30. */
  treadmill: 10_000_000_006,
  /** 6.5 km outdoors on Wed 16 Sep 2026, 19:00, without heart rate. */
  noHeartRate: 10_000_000_004,
  /** 10.2 km on Sun 6 Sep 2026, 07:30, outdoors, marked as a race in Garmin Connect. */
  race: 10_000_000_002,
} as const;

/**
 * Stores the fixture's 18 km run of 2026-09-27 directly, as a sync stores it (same Garmin id, so a later
 * sync updates this row), for tests that need a run on screen without spending a Garmin login. With
 * `race`, it is stored as a race, which the fixture's run is not: a later sync would make it uncategorized.
 */
export async function seedLongRun({ race = false }: { race?: boolean } = {}): Promise<void> {
  await withDatabase((db) =>
    db.query(
      `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
         duration_s, avg_hr, max_hr, cadence, calories, elevation_gain_m, event_type)
       values (${runnerId}, $2, 'running', '2026-09-27T06:00:00Z', '2026-09-27 08:00:00', 18000,
         6120, 148, 166, 168, 1150, 142, $3)`,
      [runner.email, fixtureRunIds.longRun, race ? RACE_EVENT_TYPE : UNCATEGORIZED],
    ),
  );
}

/** Stores the fixture's 10.2 km race of Sun 6 Sep 2026, 07:30, directly, as a sync stores it. */
export async function seedRaceDayRun(): Promise<void> {
  await withDatabase((db) =>
    db.query(
      `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
         duration_s, avg_hr, max_hr, cadence, calories, elevation_gain_m, event_type)
       values (${runnerId}, $2, 'running', '2026-09-06T05:30:00Z', '2026-09-06 07:30:00', 10200,
         3300, 158, 181, 176, 700, 40, $3)`,
      [runner.email, fixtureRunIds.race, RACE_EVENT_TYPE],
    ),
  );
}

/** Stores the fixture's 8 km treadmill run of 2026-09-24 directly, as a sync stores it: indoor, no climb. */
export async function seedTreadmillRun(): Promise<void> {
  await withDatabase((db) =>
    db.query(
      `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
         duration_s, avg_hr, max_hr, cadence, calories, elevation_gain_m, is_indoor, event_type)
       values (${runnerId}, $2, 'treadmill_running', '2026-09-24T16:30:00Z', '2026-09-24 18:30:00', 8000,
         2700, 152, 171, 172, 520, null, true, $3)`,
      [runner.email, fixtureRunIds.treadmill, UNCATEGORIZED],
    ),
  );
}

/** Garmin ids for seedRunOn: one per local date, far from the fixture account's and runHistory's. */
const SEEDED_DAY_RUN_IDS = 30_000_000_000;

/** A run for seedRunOn: how far and how long. */
export type SeededDayRun = { distanceM: number; durationS: number };

/**
 * Stores a fictional outdoor run at 07:30 on `date`, a local date in the runner's default zone (UTC), as a
 * sync stores it, for a flow or screen that needs a run on a day counted from today or from a seeded plan.
 * Its Garmin id comes from the date, so one run per day; the fixture Garmin never lists it, so a test that
 * stores one must not sync. Returns the run's id.
 */
export async function seedRunOn(
  date: string,
  { distanceM, durationS }: SeededDayRun,
): Promise<string> {
  const { rows } = await withDatabase((db) =>
    db.query<{ id: string }>(
      `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
         duration_s, event_type)
       values (${runnerId}, $2, 'running', $3::timestamp at time zone 'UTC', $3, $4, $5, $6)
       returning id`,
      [
        runner.email,
        SEEDED_DAY_RUN_IDS + Number(date.replaceAll("-", "")),
        `${date} 07:30:00`,
        distanceM,
        durationS,
        UNCATEGORIZED,
      ],
    ),
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`The run on ${date} was not stored`);
  return id;
}

/**
 * What seedRunDetail stores: an outdoor run with route, elevation and heart rate; a treadmill run without
 * route or elevation; an outdoor run whose watch recorded no heart rate (no HR series, zones or lap HR).
 */
export type RunDetailVariant = "outdoor" | "treadmill" | "noHr";

type LapProfile = {
  /** Seconds per km of each 1 km lap, repeated for a longer run and scaled to the run's own time. */
  paceS: readonly number[];
  avgHr: readonly number[];
  avgCadence: readonly number[];
};

const lapProfiles: Record<"outdoor" | "treadmill", LapProfile> = {
  // The 18 km long run's laps, 6120 s in all, so they are stored as written: a slow first km, a hill on
  // km 10 (6:06), the descent after it (5:31) and a fast last km (5:06).
  outdoor: {
    paceS: [
      352, 348, 344, 343, 341, 342, 340, 343, 341, 366, 331, 340, 337, 341, 336, 335, 334, 306,
    ],
    avgHr: [
      140, 142, 143, 144, 145, 146, 146, 147, 148, 158, 150, 149, 150, 151, 152, 153, 155, 165,
    ],
    avgCadence: [
      168, 169, 169, 170, 169, 170, 169, 170, 169, 168, 172, 170, 170, 169, 170, 171, 172, 176,
    ],
  },
  // The 8 km treadmill run's laps, 2700 s in all: steady once warm.
  treadmill: {
    paceS: [345, 340, 338, 336, 336, 335, 335, 335],
    avgHr: [138, 145, 149, 151, 153, 155, 157, 160],
    avgCadence: [170, 171, 172, 172, 172, 173, 173, 174],
  },
};

/** Garmin's five zones: lower bounds, and the long run's seconds in each, scaled to any run's time. */
const zoneLowBpm = [98, 118, 137, 157, 176] as const;
const zoneSecondsOfLongRun = [180, 1260, 3120, 1440, 120] as const;

/** About what Garmin's detail call leaves of a run, and what a chart draws without downsampling. */
const SAMPLES = 600;
const ROUTE_POINTS = 300;

type SeededLap = {
  idx: number;
  distanceM: number;
  durationS: number;
  avgHr: number | null;
  avgCadence: number;
};

type SeededDetail = {
  laps: SeededLap[];
  elapsedS: number[];
  distanceM: number[];
  hr: number[] | null;
  cadence: number[];
  elevationM: number[] | null;
  speedMps: number[];
  route: [number, number][] | null;
  hrZones: { zone: number; lowBpm: number; seconds: number }[] | null;
};

function at(values: readonly number[], index: number): number {
  const value = values[index % values.length];
  if (value === undefined) throw new Error("A lap profile is empty");
  return value;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // + 0 turns -0 into 0.
  return Math.round(value * factor) / factor + 0;
}

/** 1 km laps (the last one shorter) paced by the profile, scaled so they add up to the run's time. */
function seededLaps(
  distanceM: number,
  durationS: number,
  profile: LapProfile,
  withHr: boolean,
): SeededLap[] {
  const count = Math.ceil(distanceM / 1000);
  const laps = Array.from({ length: count }, (_, index) => {
    const lapDistance = Math.min(1000, distanceM - index * 1000);
    return {
      idx: index + 1,
      distanceM: lapDistance,
      durationS: (at(profile.paceS, index) * lapDistance) / 1000,
      avgHr: withHr ? at(profile.avgHr, index) : null,
      avgCadence: at(profile.avgCadence, index),
    };
  });
  const scale = durationS / laps.reduce((sum, lap) => sum + lap.durationS, 0);
  return laps.map((lap) => ({ ...lap, durationS: round(lap.durationS * scale, 3) }));
}

/** A lap value at time t: straight lines between lap midpoints, from `startValue` at the start. */
function lapCurve(
  laps: readonly SeededLap[],
  value: (lap: SeededLap) => number,
  startValue: number,
): (t: number) => number {
  const points: [number, number][] = [[0, startValue]];
  let lapStart = 0;
  for (const lap of laps) {
    points.push([lapStart + lap.durationS / 2, value(lap)]);
    lapStart += lap.durationS;
  }
  return (t) => {
    const next = points.findIndex(([time]) => time >= t);
    if (next <= 0) return points[next === 0 ? 0 : points.length - 1]?.[1] ?? startValue;
    const [t0, v0] = points[next - 1] ?? [0, startValue];
    const [t1, v1] = points[next] ?? [t0, v0];
    return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  };
}

/**
 * A fictional loop in open ocean around 0.0, -30.0, uneven so it reads as a route: never anyone's real
 * coordinates.
 */
function oceanLoop(): [number, number][] {
  return Array.from({ length: ROUTE_POINTS + 1 }, (_, index) => {
    const angle = (2 * Math.PI * index) / ROUTE_POINTS;
    const radius = 1 + 0.12 * Math.sin(3 * angle) + 0.05 * Math.cos(5 * angle);
    return [
      round(0.024 * radius * Math.sin(angle), 6),
      round(-30 + 0.036 * radius * Math.cos(angle), 6),
    ];
  });
}

/** Deterministic laps, samples, route and zones for a stored run of this distance and time. */
function syntheticDetail(
  distanceM: number,
  durationS: number,
  variant: RunDetailVariant,
): SeededDetail {
  const indoor = variant === "treadmill";
  const withHr = variant !== "noHr";
  const laps = seededLaps(
    distanceM,
    durationS,
    lapProfiles[indoor ? "treadmill" : "outdoor"],
    withHr,
  );

  const lapEnds: { time: number; distance: number; lap: SeededLap }[] = [];
  let time = 0;
  let distance = 0;
  for (const lap of laps) {
    time += lap.durationS;
    distance += lap.distanceM;
    lapEnds.push({ time, distance, lap });
  }
  // The climb tops out where the slowest lap after the first ends.
  const slowest = laps
    .slice(1)
    .reduce<SeededLap | undefined>(
      (slow, lap) =>
        !slow || lap.durationS / lap.distanceM > slow.durationS / slow.distanceM ? lap : slow,
      undefined,
    );
  const hilltopM = slowest ? slowest.idx * 1000 : distanceM / 2;

  const hrAt = lapCurve(laps, (lap) => lap.avgHr ?? 0, 118);
  const cadenceAt = lapCurve(laps, (lap) => lap.avgCadence, 166);
  const detail: SeededDetail = {
    laps,
    elapsedS: [],
    distanceM: [],
    hr: withHr ? [] : null,
    cadence: [],
    elevationM: indoor ? null : [],
    speedMps: [],
    route: indoor ? null : oceanLoop(),
    hrZones: withHr ? zones(durationS) : null,
  };
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const t = (durationS * sample) / (SAMPLES - 1);
    const end = lapEnds.find((candidate) => candidate.time >= t - 1e-9) ?? lapEnds.at(-1);
    if (!end) throw new Error("A run with detail needs at least one lap");
    const { lap } = end;
    const d = end.distance - (lap.distanceM * (end.time - t)) / lap.durationS;
    detail.elapsedS.push(round(t, 1));
    detail.distanceM.push(round(Math.max(0, d), 1));
    // Drift on two slow, unrelated periods, so the lines wander as a run does rather than zigzag.
    const drift = 0.6 * Math.sin(t / 97) + 0.4 * Math.sin(t / 233);
    detail.hr?.push(round(hrAt(t) + 2 * drift, 0));
    detail.cadence.push(round(cadenceAt(t) + drift, 1));
    // Gentle rolls, and one climb of about 45 m over the 2 km before the hilltop.
    const rolls = 4 * Math.sin((2 * Math.PI * d) / 3100) + 2 * Math.sin((2 * Math.PI * d) / 1300);
    const climb = 46 * Math.exp(-(((d - hilltopM) / 1100) ** 2));
    detail.elevationM?.push(round(14 + rolls + climb, 1));
    detail.speedMps.push(round(lap.distanceM / lap.durationS + 0.05 * drift, 2));
  }
  return detail;
}

/** The long run's share of each zone, in whole seconds that add up to the run's time. */
function zones(durationS: number): SeededDetail["hrZones"] {
  const total = zoneSecondsOfLongRun.reduce((sum, seconds) => sum + seconds, 0);
  const seconds = zoneSecondsOfLongRun.map((share) => Math.round((share * durationS) / total));
  // Rounding leftovers go to zone 3, the biggest.
  seconds[2] =
    Math.round(durationS) -
    seconds.reduce((sum, value, index) => (index === 2 ? sum : sum + value), 0);
  return seconds.map((value, index) => ({
    zone: index + 1,
    lowBpm: at(zoneLowBpm, index),
    seconds: value,
  }));
}

/**
 * Stores laps, samples, route and zones for an already stored run, as the first open of the run screen
 * would after fetching them from Garmin, so the screen shows them without a Garmin login. Synthetic and
 * deterministic: built from the run's distance and time. Both rows go with the run when resetRunner
 * deletes it (on delete cascade).
 */
export async function seedRunDetail(
  garminActivityId: number,
  variant: RunDetailVariant,
): Promise<void> {
  await withDatabase(async (db) => {
    const { rows } = await db.query<{ id: string; distance_m: number; duration_s: number }>(
      `select id, distance_m, duration_s from activity
       where user_id = ${runnerId} and garmin_activity_id = $2`,
      [runner.email, garminActivityId],
    );
    const run = rows[0];
    if (!run) throw new Error(`No stored run with Garmin id ${garminActivityId} to add detail to`);
    const detail = syntheticDetail(run.distance_m, run.duration_s, variant);

    await db.query("begin");
    try {
      await db.query(
        `insert into activity_stream (activity_id, elapsed_s, distance_m, hr, cadence, elevation_m,
           speed_mps, route, hr_zones)
         values ($1, $2::real[], $3::real[], $4::real[], $5::real[], $6::real[], $7::real[], $8::jsonb,
           $9::jsonb)`,
        [
          run.id,
          detail.elapsedS,
          detail.distanceM,
          detail.hr,
          detail.cadence,
          detail.elevationM,
          detail.speedMps,
          detail.route === null ? null : JSON.stringify(detail.route),
          detail.hrZones === null ? null : JSON.stringify(detail.hrZones),
        ],
      );
      await db.query(
        `insert into activity_lap (activity_id, idx, distance_m, duration_s, avg_hr, avg_cadence)
         select $1, lap.idx, lap.distance_m, lap.duration_s, lap.avg_hr, lap.avg_cadence
         from unnest($2::int[], $3::float8[], $4::float8[], $5::float8[], $6::float8[])
           as lap(idx, distance_m, duration_s, avg_hr, avg_cadence)`,
        [
          run.id,
          detail.laps.map((lap) => lap.idx),
          detail.laps.map((lap) => lap.distanceM),
          detail.laps.map((lap) => lap.durationS),
          detail.laps.map((lap) => lap.avgHr),
          detail.laps.map((lap) => lap.avgCadence),
        ],
      );
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

type SeededRun = {
  /** Wall-clock start where the runner ran, Berlin summer time (UTC+2). */
  startLocal: string;
  distanceM: number;
  durationS: number;
  indoor?: boolean;
  manual?: boolean;
  /** Marked as a race in Garmin Connect; every other run is uncategorized, as Garmin sends it. */
  race?: boolean;
};

/**
 * Ten weeks of a fictional 10K build, newest first: 24 runs from Wed 22 Jul to Sun 27 Sep 2026, every week
 * from 20–26 Jul to 21–27 Sep with two or three runs. Progress shows the eight newest weeks (21–27 Sep back
 * to 3–9 Aug) and Show earlier weeks the last two. Week totals in km, newest first: 30, 27, 24, 20, 22, 20,
 * 18, 16, then 15 and 12. The treadmill run of Thu 24 Sep is indoor, the run of Thu 17 Sep entered by hand,
 * the 5 km of Thu 10 Sep a race.
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
  { startLocal: "2026-09-10T18:30:00", distanceM: 5000, durationS: 1650, race: true },
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

/**
 * Garmin ids grow over time; these sit far from the fixture account's, so a sync never updates them. The
 * fixture account does not list them either: a sync removes runs Garmin no longer lists, but none when more
 * than 10 would go at once (MAX_RUNS_REMOVED_PER_SYNC in apps/api), so all 24 of runHistory stay.
 */
const firstHistoryGarminId = 20_000_000_001;

/** The Garmin id seedRunHistory gives the run of runHistory that starts at `startLocal`. */
export function historyRunId(startLocal: string): number {
  const index = [...runHistory].reverse().findIndex((run) => run.startLocal === startLocal);
  if (index < 0) throw new Error(`runHistory has no run starting at ${startLocal}`);
  return firstHistoryGarminId + index;
}

/** Stores runHistory as an import would, in one statement. */
export async function seedRunHistory(): Promise<void> {
  const oldestFirst = [...runHistory].reverse();
  await withDatabase((db) =>
    db.query(
      `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
         duration_s, is_indoor, is_manual, event_type)
       select ${runnerId}, run.garmin_id, run.type, run.start_local at time zone 'Europe/Berlin',
         run.start_local, run.distance_m, run.duration_s, run.indoor, run.manual, run.event_type
       from unnest($2::bigint[], $3::text[], $4::timestamp[], $5::float8[], $6::float8[], $7::bool[],
         $8::bool[], $9::text[])
         as run(garmin_id, type, start_local, distance_m, duration_s, indoor, manual, event_type)`,
      [
        runner.email,
        oldestFirst.map((_, index) => firstHistoryGarminId + index),
        oldestFirst.map((run) => (run.indoor ? "treadmill_running" : "running")),
        oldestFirst.map((run) => run.startLocal),
        oldestFirst.map((run) => run.distanceM),
        oldestFirst.map((run) => run.durationS),
        oldestFirst.map((run) => run.indoor ?? false),
        oldestFirst.map((run) => run.manual ?? false),
        oldestFirst.map((run) => (run.race ? RACE_EVENT_TYPE : UNCATEGORIZED)),
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
      /** With no page job queued, which the API reports as stalled. */
      status: "running";
      startedAt: string;
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
 * A first import whose job chain died before any page: the row says running, but seedImportProgress queues
 * no page, so the API reports it stalled and Resume import picks it up from offset 0.
 */
export const importStalled = {
  status: "running",
  startedAt: "2026-09-28T06:00:00Z",
  oldestDate: null,
  nextOffset: 0,
} as const satisfies SeededImport;

/** Writes the runner's import_progress row as the import would have left it; queues no page. */
export async function seedImportProgress(progress: SeededImport): Promise<void> {
  const finishedAt = progress.status === "done" ? progress.finishedAt : null;
  await withDatabase((db) =>
    db.query(
      `insert into import_progress (user_id, status, next_offset, cursor_date, started_at, finished_at)
       values (${runnerId}, $2, $3, $4, $5, $6)`,
      [
        runner.email,
        progress.status,
        progress.nextOffset,
        progress.oldestDate,
        progress.startedAt,
        finishedAt,
      ],
    ),
  );
}

/**
 * The engine's BEST_EFFORTS_VERSION (packages/engine/src/constants.ts), which the web app does not depend
 * on: a run stored with it counts as checked. Bump it with the engine's; until then every seeded run counts
 * as pending, and the specs that expect none fail on the pending line under "Personal bests".
 */
const BEST_EFFORTS_VERSION = 1;

/**
 * The instant specs that show personal bests pin the browser clock to (page.clock.setFixedTime): Wed 30 Sep
 * 2026, three days after the newest seeded and fixture run (Sun 27 Sep), so the bests that run holds read
 * "New" and older ones do not, whatever the date.
 */
export const bestsCheckedAt = new Date("2026-09-30T12:00:00Z");

/** One stored run's best efforts: timer seconds per distance, unrounded, as the best-efforts job writes them. */
export type SeededEfforts = {
  garminActivityId: number;
  efforts: Partial<Record<DistanceKey, number>>;
};

/** The runs of runHistory that seeded best efforts sit on, by Garmin id. */
export const historyRunIds = {
  /** Sun 27 Sep, 16 km in 1:32:00: the newest run. */
  longRun: historyRunId("2026-09-27T08:00:00"),
  /** Thu 24 Sep, 6 km on a treadmill. */
  treadmill: historyRunId("2026-09-24T18:45:00"),
  /** Tue 22 Sep, 8 km in 44:00. */
  tempo: historyRunId("2026-09-22T18:30:00"),
  /** Thu 17 Sep, 5 km entered by hand. */
  manual: historyRunId("2026-09-17T07:00:00"),
  /** Sun 13 Sep, 12 km in 1:09:00, faster at the end. */
  progression: historyRunId("2026-09-13T08:00:00"),
  /** Thu 10 Sep, the 5 km race in 27:30. */
  race: historyRunId("2026-09-10T18:30:00"),
  /** Sun 6 Sep, 13 km in 1:14:45. */
  sundaySixth: historyRunId("2026-09-06T08:00:00"),
  /** Wed 2 Sep, 7 km in 38:30 with a fast last km. */
  fastFinish: historyRunId("2026-09-02T18:30:00"),
} as const;

/**
 * What a finished best-efforts pass could leave on runHistory, cut to the runs that matter: the ones that
 * hold a best and a few slower ones they beat, newer ones among them, so the fastest wins rather than the
 * newest. seedBestEfforts marks every other outdoor run checked with no efforts. The bests: 1K 4:58 (Wed
 * 2 Sep); 1 mi 8:12, 2 mi 17:21 and 5K 27:29 (the race of Thu 10 Sep; its 1649.7 s shows a time is cut to
 * the second, not rounded); 5 mi 45:10 (Sun 13 Sep); 10K 56:41 and 15K 1:25:52 (Sun 27 Sep, "New" at
 * bestsCheckedAt). No run reaches 10 mi, so 10 mi, 20K, half and marathon have none.
 */
export const historyBestEfforts: readonly SeededEfforts[] = [
  {
    garminActivityId: historyRunIds.longRun,
    efforts: {
      "1k": 312.4,
      "1mi": 511,
      "2mi": 1064.2,
      "5k": 1686.5,
      "5mi": 2737.9,
      "10k": 3401.8,
      "15k": 5152.3,
    },
  },
  {
    garminActivityId: historyRunIds.tempo,
    efforts: { "1k": 305.1, "1mi": 504.6, "2mi": 1050.8, "5k": 1655.8 },
  },
  {
    garminActivityId: historyRunIds.progression,
    efforts: {
      "1k": 318,
      "1mi": 515.2,
      "2mi": 1062,
      "5k": 1676.9,
      "5mi": 2710.2,
      "10k": 3436.4,
    },
  },
  {
    garminActivityId: historyRunIds.race,
    efforts: { "1k": 300.2, "1mi": 492.9, "2mi": 1041.4, "5k": 1649.7 },
  },
  {
    garminActivityId: historyRunIds.sundaySixth,
    efforts: {
      "1k": 320,
      "1mi": 518.3,
      "2mi": 1069.9,
      "5k": 1702.2,
      "5mi": 2765.1,
      "10k": 3450.2,
    },
  },
  {
    garminActivityId: historyRunIds.fastFinish,
    efforts: { "1k": 298.6, "1mi": 497.5, "2mi": 1047, "5k": 1660.4 },
  },
];

/**
 * Efforts on runHistory's treadmill run (Thu 24 Sep) and its run entered by hand (Thu 17 Sep), faster than
 * every outdoor best. The job never computes either kind; rows like these are what a run changed in Garmin
 * after its efforts were computed would keep (a sync clears them only when distance or time changes), so
 * only the read keeps them out of the bests.
 */
export const indoorAndManualEfforts: readonly SeededEfforts[] = [
  {
    garminActivityId: historyRunIds.treadmill,
    efforts: { "1k": 290, "1mi": 480, "2mi": 1010, "5k": 1630 },
  },
  {
    garminActivityId: historyRunIds.manual,
    efforts: { "1k": 285, "1mi": 475, "2mi": 1000, "5k": 1620 },
  },
];

/**
 * Best efforts on seedLongRun's 18 km and seedRaceDayRun's race, for the run screen's capture. The long
 * run's are what its seeded laps give (seedRunDetail, outdoor: 1 km laps at even pace, the last one 5:06
 * after 5:35 and 5:34): 1K is that last km, 5K and 10K the last 5 and 10 laps, 15K all but the first three.
 * The race three weeks earlier is faster at every distance it covers, so the long run holds only 15K and
 * 10 mi, and its rows show both a best and a slower effort.
 */
export const longRunBestEfforts: readonly SeededEfforts[] = [
  {
    garminActivityId: fixtureRunIds.longRun,
    efforts: {
      "1k": 306,
      "1mi": 509.52,
      "2mi": 1048.48,
      "5k": 1652,
      "5mi": 2677.1,
      "10k": 3367,
      "15k": 5076,
      "10mi": 5452.52,
    },
  },
  {
    garminActivityId: fixtureRunIds.race,
    efforts: {
      "1k": 297.4,
      "1mi": 486.2,
      "2mi": 1004.8,
      "5k": 1608.3,
      "5mi": 2601.9,
      "10k": 3237.6,
    },
  },
];

/**
 * Waits until the best-efforts job a sync queued has checked every stored run and stopped, so a screen
 * opened next reads the bests as they end up, never whichever side of the job it lands on. The worker takes
 * the job within 2 s of the sync and checks up to ten runs in one batch.
 */
export async function waitForBestEfforts(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get("/api/personal-bests");
        const { pendingRuns, checking } = personalBestsResponseSchema.parse(await response.json());
        return pendingRuns === 0 && !checking;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/**
 * Stores best efforts on runs already stored, as the best-efforts job writes them, then marks runs checked
 * as a finished pass leaves them: every outdoor, recorded run of 1 km or more, plus every run named here
 * (so efforts on an indoor or manual run count as computed, and only the read can leave them out). Nothing
 * is left pending, so the bests show no pending line and do not poll. start_s is 0: nothing on
 * screen reads where in a run an effort starts.
 */
export async function seedBestEfforts(runs: readonly SeededEfforts[]): Promise<void> {
  const rows = runs.flatMap(({ garminActivityId, efforts }) =>
    Object.entries(efforts).flatMap(([distanceKey, timeS]) =>
      timeS === undefined ? [] : [{ garminActivityId, distanceKey, timeS }],
    ),
  );
  await withDatabase(async (db) => {
    const inserted = await db.query(
      `insert into best_effort (user_id, activity_id, distance_key, time_s, start_s)
       select activity.user_id, activity.id, effort.distance_key, effort.time_s, 0
       from unnest($2::bigint[], $3::text[], $4::float8[]) as effort(garmin_id, distance_key, time_s)
       join activity on activity.user_id = ${runnerId} and activity.garmin_activity_id = effort.garmin_id`,
      [
        runner.email,
        rows.map((row) => row.garminActivityId),
        rows.map((row) => row.distanceKey),
        rows.map((row) => row.timeS),
      ],
    );
    if (inserted.rowCount !== rows.length) {
      throw new Error("Seeding best efforts named a run that is not stored: seed the runs first");
    }
    await db.query(
      `update activity set best_efforts_version = $2
       where user_id = ${runnerId}
         and ((not is_indoor and not is_manual and distance_m >= 1000)
           or garmin_activity_id = any($3::bigint[]))`,
      [runner.email, BEST_EFFORTS_VERSION, runs.map((run) => run.garminActivityId)],
    );
  });
}

/** The recent race seedPlan's goal carries: a 10K in 54:41, typed in. */
const seededRecentTime = { distanceKey: "10k", timeS: 3281 } as const satisfies RecentTime;

/**
 * The goal and plan seedPlan stores, as if saved on Fri 2 Oct 2026: a half marathon on Sun 21 Feb 2027,
 * 4 runs a week with the long run on Sunday, paces from a typed-in 10K of 54:41, after four weeks of 22 to
 * 30 km. The plan runs 20 weeks from Mon 5 Oct 2026, the first Monday after that Friday.
 */
export const seededPlanInput: PlanGenerationInput = {
  goal: {
    kind: "race",
    distanceKey: "half",
    raceDate: "2027-02-21",
    targetTimeS: null,
    daysPerWeek: 4,
    longRunDay: "sun",
    recentTime: seededRecentTime,
  },
  startDate: "2026-10-05",
  baseline: {
    weeklyVolumesM: [25_000, 28_000, 22_000, 30_000],
    longestRunM: 15_000,
    daysSinceLastRun: 2,
  },
  vdotSource: {
    origin: "entered",
    distanceM: 10_000,
    timeS: seededRecentTime.timeS,
    activityId: null,
    date: null,
  },
};

/** When seedPlan's goal and plan were saved; nothing on screen shows it, but every row reads the same. */
const planSavedAt = "2026-10-02T09:00:00Z";

/**
 * The instant specs that show seedPlan's weeks pin the browser clock to (page.clock.setFixedTime): Wed 14
 * Oct 2026, in week 2 (12–18 Oct), so that week's card is the current one whatever the date.
 */
export const planWeekTwoAt = new Date("2026-10-14T09:00:00Z");

/** The engine's plan for a seeded goal, which never conflicts. */
function generateSeededPlan(input: PlanGenerationInput): GeneratedPlan {
  const result = generatePlan(input);
  if (!result.ok) {
    throw new Error(`The engine answered the seeded goal with a conflict: ${result.conflict.code}`);
  }
  return result.plan;
}

/** A plan session as storePlan writes it. */
type SessionRow = {
  date: string;
  type: SessionType;
  phase: PlanPhase;
  target: SessionTarget;
  steps: SessionSteps;
};

/**
 * Stores the input's goal with its generated plan as PUT /api/goal saves them
 * (apps/api/src/services/plan.ts), in one transaction: the goal row, version 1 of its plan, active, and the
 * sessions `writeSessions` inserts for that plan.
 */
async function storePlan<T>(
  input: PlanGenerationInput,
  generated: GeneratedPlan,
  writeSessions: (db: pg.Client, plan: { id: string; user_id: string }) => Promise<T>,
): Promise<T> {
  const { goal, vdotSource } = input;
  if (goal.kind !== "race") throw new Error("A seeded goal is a race");

  return withDatabase(async (db) => {
    await db.query("begin");
    try {
      const goalRows = await db.query<{ id: string }>(
        `insert into goal (user_id, kind, distance_key, race_date, target_time_s, days_per_week,
           long_run_day, recent_distance_key, recent_time_s, created_at, updated_at)
         values (${runnerId}, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         returning id`,
        [
          runner.email,
          goal.kind,
          goal.distanceKey,
          goal.raceDate,
          goal.targetTimeS,
          goal.daysPerWeek,
          goal.longRunDay,
          seededRecentTime.distanceKey,
          seededRecentTime.timeS,
          planSavedAt,
        ],
      );
      const goalId = goalRows.rows[0]?.id;
      if (goalId === undefined) throw new Error("The goal insert returned nothing");

      const planRows = await db.query<{ id: string; user_id: string }>(
        `insert into plan (goal_id, user_id, version, engine_version, status, start_date, end_date, vdot,
           vdot_source, paces, inputs, warnings, created_at, updated_at)
         values ($2, ${runnerId}, 1, $3, 'active', $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
           $11, $11)
         returning id, user_id`,
        [
          runner.email,
          goalId,
          generated.engineVersion,
          generated.startDate,
          generated.endDate,
          generated.vdot,
          JSON.stringify(vdotSource),
          JSON.stringify(generated.paces),
          JSON.stringify(input),
          JSON.stringify(generated.warnings),
          planSavedAt,
        ],
      );
      const planRow = planRows.rows[0];
      if (planRow === undefined) throw new Error("The plan insert returned nothing");

      const written = await writeSessions(db, planRow);
      await db.query("commit");
      return written;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

/**
 * Stores seededPlanInput's goal with the plan the engine makes from it, as PUT /api/goal saves them
 * (apps/api/src/services/plan.ts): the goal row, version 1 of its plan, active, and one plan_session per
 * session with its week's phase. Written directly with the engine's own output, so the plan is what the API
 * would make from these inputs on 2 Oct 2026 whatever today is; a change to the engine's rules changes the
 * seeded plan with it. Returns the plan for tests that assert on its numbers.
 */
export async function seedPlan(): Promise<GeneratedPlan> {
  const generated = generateSeededPlan(seededPlanInput);
  const sessions: SessionRow[] = generated.weeks.flatMap((week) =>
    week.sessions.map((session) => ({ ...session, phase: week.phase })),
  );

  await storePlan(seededPlanInput, generated, (db, plan) =>
    db.query(
      `insert into plan_session (plan_id, user_id, date, type, phase, target, steps, created_at,
         updated_at)
       select $1, $2, session.date, session.type, session.phase, session.target, session.steps, $4, $4
       from jsonb_to_recordset($3::jsonb)
         as session(date date, type text, phase text, target jsonb, steps jsonb)`,
      [plan.id, plan.user_id, JSON.stringify(sessions), planSavedAt],
    ),
  );
  return generated;
}

/** The weeks seedPlanSessions' plan runs, as seedPlan's: a half marathon 20 weeks on. */
const PLAN_WEEKS = 20;

/**
 * seededPlanInput moved to start on the Monday of the week that holds `date`, its race on the Sunday 20
 * weeks on: the same runner and recent 10K, so the same paces, in a plan that holds that day.
 */
function planInputAround(date: string): PlanGenerationInput {
  const startDate = weekStart(date);
  const { goal } = seededPlanInput;
  if (goal.kind !== "race") throw new Error("A seeded goal is a race");
  return {
    ...seededPlanInput,
    startDate,
    goal: { ...goal, raceDate: addDays(startDate, PLAN_WEEKS * 7 - 1) },
  };
}

/** A session for seedPlanSessions to store: its day and its type, one the seeded plan has. */
export type SeededSession = { date: string; type: SessionType };

/** A session as seedPlanSessions stored it. */
export type StoredSession = SeededSession & {
  id: string;
  target: SessionTarget;
  steps: SessionSteps;
};

/**
 * For flows on the real clock: stores seededPlanInput's goal with its plan, active, as seedPlan does, but
 * moved to the week of runnerToday() (planInputAround) and with only the sessions named, each on its day
 * with the steps, target and phase of the first session of its type in that plan. A flow then knows which
 * sessions sit in the days the API keeps on Garmin. Name at least one, inside the plan's 20 weeks: the API
 * refuses to read a plan without sessions (GET /api/plan), as the engine never makes one. Returns the
 * stored sessions in the order named.
 */
export async function seedPlanSessions(
  sessions: readonly SeededSession[],
): Promise<StoredSession[]> {
  if (sessions.length === 0) throw new Error("A seeded plan needs at least one session");
  const input = planInputAround(runnerToday());
  const generated = generateSeededPlan(input);
  const planned = generated.weeks.flatMap((week) =>
    week.sessions.map((session) => ({ ...session, phase: week.phase })),
  );
  const rows: SessionRow[] = sessions.map(({ date, type }) => {
    const model = planned.find((session) => session.type === type);
    if (!model) throw new Error(`The seeded plan has no ${type} session`);
    return { ...model, date };
  });

  return storePlan(input, generated, async (db, plan) => {
    const stored: StoredSession[] = [];
    for (const row of rows) {
      const inserted = await db.query<{ id: string }>(
        `insert into plan_session (plan_id, user_id, date, type, phase, target, steps, created_at,
           updated_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $8)
         returning id`,
        [
          plan.id,
          plan.user_id,
          row.date,
          row.type,
          row.phase,
          JSON.stringify(row.target),
          JSON.stringify(row.steps),
          planSavedAt,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error("The session insert returned nothing");
      stored.push({ id, date: row.date, type: row.type, target: row.target, steps: row.steps });
    }
    return stored;
  });
}

/**
 * Garmin ids for seedSessionsOnGarmin, counted per worker: far from the fixture Garmin's own (workouts
 * from 900000001, schedules from 800000001, its calendar's other apps from 5000000001), and never shown.
 */
const SEEDED_WORKOUT_IDS = 700_000_000;
const SEEDED_SCHEDULE_IDS = 600_000_000;
let seededOnGarmin = 0;

/**
 * Marks the runner's sessions on these days as on Garmin, as a finished push leaves them: workout and
 * schedule ids, the day it is scheduled on, and the hash of the workout the API would send for it now
 * (desiredWorkout in apps/api/src/services/workout-push-plan.ts: the active plan's paces, the default
 * units), so the API answers onGarmin for each. A push that runs later moves or removes them on the fixture
 * Garmin like any it made. Seed the plan first.
 */
export async function seedSessionsOnGarmin(dates: readonly string[]): Promise<void> {
  await withDatabase(async (db) => {
    const plans = await db.query<{ paces: PlanPaces }>(
      `select paces from plan where user_id = ${runnerId} and status = 'active'`,
      [runner.email],
    );
    const paces = plans.rows[0]?.paces;
    if (!paces) throw new Error("Seed a plan before putting its sessions on Garmin");
    const { rows } = await db.query<{
      id: string;
      date: string;
      type: SessionType;
      title: string | null;
      target: SessionTarget;
      steps: SessionSteps;
    }>(
      `select id, date::text as date, type, title, target, steps from plan_session
       where user_id = ${runnerId} and date = any($2::date[])
       order by date, id`,
      [runner.email, dates],
    );
    const missing = dates.filter((date) => !rows.some((row) => row.date === date));
    if (missing.length > 0) throw new Error(`No session to put on Garmin on ${missing.join(", ")}`);

    for (const row of rows) {
      seededOnGarmin += 1;
      const workout = garminWorkout({
        name: garminWorkoutName(row, defaultSettings.units),
        steps: row.steps,
        paces,
      });
      await db.query(
        `update plan_session
         set garmin_workout_id = $2, garmin_schedule_id = $3, garmin_date = date, garmin_hash = $4
         where id = $1`,
        [
          row.id,
          String(SEEDED_WORKOUT_IDS + seededOnGarmin),
          String(SEEDED_SCHEDULE_IDS + seededOnGarmin),
          createHash("sha256").update(JSON.stringify(workout)).digest("hex"),
        ],
      );
    }
  });
}

/**
 * The instant the adjusted week's capture pins the browser clock to (page.clock.setFixedTime): Thu 22 Oct
 * 2026, in week 3 (19–25 Oct) of seedPlan's plan, so Mon 19 and Wed 21 are past and Add shows from Thu 22.
 */
export const planWeekThreeAt = new Date("2026-10-22T09:00:00Z");

/** seedAdjustedPlan's story, in the runner's local dates. */
const adjustedStory = {
  /** Sick from the day after the last run, Mon 5 Oct. */
  pausedOn: "2026-10-06",
  /** "I'm back": 9 days after that run, so the return runs at 70% with a walk-run first week. */
  backOn: "2026-10-14",
  daysOff: 9,
  /** The first walk-run of week 3, run and matched. */
  doneOn: "2026-10-19",
  /** The tempo after it, which the coach's review of that run turned easy, then not run. */
  changedOn: "2026-10-21",
} as const;

/** A plan session as seedAdjustedPlan reads it back. */
type StoredPlanSession = {
  id: string;
  date: string;
  type: SessionType;
  status: SessionStatus;
  title: string | null;
  target: SessionTarget;
  steps: SessionSteps;
};

/** The fields a change writes back to the session and logs before and after. */
function adjustedOf({ type, title, status, steps, target }: StoredPlanSession): AdjustedSession {
  return { type, title, status, steps, target };
}

/** One change as the API writes it: the session in place, then its plan_adjustment row. */
type SeededChange = {
  session: StoredPlanSession;
  after: AdjustedSession;
  source: "coach" | "pause";
  kind: "easy" | "re_entry";
  requested: object;
  /** When the change was made, which orders a session's changes. */
  at: string;
  pauseId?: string;
  activityId?: string;
};

async function writeChange(db: pg.Client, change: SeededChange): Promise<StoredPlanSession> {
  const { session, after } = change;
  await db.query(
    `update plan_session set type = $2, title = $3, status = $4, steps = $5::jsonb, target = $6::jsonb
     where id = $1`,
    [
      session.id,
      after.type,
      after.title,
      after.status,
      JSON.stringify(after.steps),
      JSON.stringify(after.target),
    ],
  );
  await db.query(
    `insert into plan_adjustment (user_id, plan_session_id, source, kind, outcome, requested, applied,
       before, after, pause_id, activity_id, created_at, updated_at)
     values (${runnerId}, $2, $3, $4, 'applied', $5::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10,
       $10)`,
    [
      runner.email,
      session.id,
      change.source,
      change.kind,
      JSON.stringify(change.requested),
      JSON.stringify(adjustedOf(session)),
      JSON.stringify(after),
      change.pauseId ?? null,
      change.activityId ?? null,
      change.at,
    ],
  );
  return { ...session, ...after };
}

/**
 * seedPlan's plan after the adaptation had its way with it, for the adjusted week's capture (week 3,
 * 19–25 Oct, at planWeekThreeAt). The runner was sick from Tue 6 Oct and tapped I'm back on Wed 14, 9 days
 * after the last run: the engine's own reEntryPlan eases every session from that day as the API does
 * (source pause), so the first 7 days are walk-run and the weeks after run at 70% and build back up. In
 * week 3 the walk-run of Mon 19 was run (done, linked to its run); the coach's review of that run turned
 * Wed 21's eased tempo into an easy run of the same time (applyDelta, source coach); Wed 21 was then not
 * run (missed); Fri 23 and Sun 25 stay eased. Written directly, with the engine's numbers, so it holds
 * whatever the date; only week 3's past sessions carry what a sync would have matched.
 */
export async function seedAdjustedPlan(): Promise<void> {
  const { pausedOn, backOn, daysOff, doneOn, changedOn } = adjustedStory;
  const { paces } = await seedPlan();
  // A walk-run of 20 minutes, as the session asks.
  const runId = await seedRunOn(doneOn, { distanceM: 3000, durationS: 1260 });

  await withDatabase(async (db) => {
    await db.query("begin");
    try {
      const pauses = await db.query<{ id: string }>(
        `insert into training_pause (user_id, reason, started_on, ended_on, created_at, updated_at)
         values (${runnerId}, 'sick', $2, $3, $4, $5)
         returning id`,
        [runner.email, pausedOn, backOn, `${pausedOn}T07:00:00Z`, `${backOn}T07:00:00Z`],
      );
      const pauseId = pauses.rows[0]?.id;
      if (pauseId === undefined) throw new Error("The pause insert returned nothing");

      // The re-entry reads the sessions from the Monday of the first day back, as the API's does.
      const { rows } = await db.query<StoredPlanSession>(
        `select id, date::text as date, type, status, title, target, steps from plan_session
         where user_id = ${runnerId} and date >= $2
         order by date, id`,
        [runner.email, weekStart(backOn)],
      );
      const sessions = new Map(rows.map((row) => [row.id, row]));
      const reEntry = reEntryPlan({
        fromDate: backOn,
        daysOff,
        walkRun: true,
        sessions: rows.map((row) => ({ ...row, source: "plan" as const })),
        paces,
      });
      for (const { id, session: after } of reEntry.changes) {
        const session = sessions.get(id);
        if (!session) throw new Error(`The re-entry changed a session it was not given: ${id}`);
        sessions.set(
          id,
          await writeChange(db, {
            session,
            after,
            source: "pause",
            kind: "re_entry",
            requested: { factor: reEntry.factor, walkRun: true, daysOff },
            at: `${backOn}T07:00:00Z`,
            pauseId,
          }),
        );
      }

      const onDay = (date: string) => {
        const session = [...sessions.values()].find((candidate) => candidate.date === date);
        if (!session) throw new Error(`The seeded plan has no session on ${date}`);
        return session;
      };
      const done = onDay(doneOn);
      if (done.title !== WALK_RUN_TITLE) throw new Error(`${doneOn} is not a walk-run`);
      await db.query(`update plan_session set status = 'done', activity_id = $2 where id = $1`, [
        done.id,
        runId,
      ]);

      const changed = onDay(changedOn);
      if (changed.type !== "tempo") throw new Error(`${changedOn} is not a tempo`);
      await writeChange(db, {
        session: changed,
        after: applyDelta({ ...changed, source: "plan" }, { kind: "easy" }, paces),
        source: "coach",
        kind: "easy",
        requested: { kind: "easy" },
        // After the walk-run's review, written once the run was in.
        at: `${doneOn}T09:00:00Z`,
        activityId: runId,
      });
      await db.query(`update plan_session set status = 'missed' where id = $1`, [changed.id]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}
