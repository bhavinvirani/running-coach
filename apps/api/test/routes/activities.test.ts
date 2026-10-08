import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BEST_EFFORTS_VERSION } from "@running-coach/engine";
import {
  type ActivityResponse,
  type ActivityWeeksResponse,
  activityResponseSchema,
  activityWeeksResponseSchema,
  type DistanceKey,
  ErrorCode,
  latestActivityResponseSchema,
  RACE_EVENT_TYPE,
} from "@running-coach/shared";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import {
  activity,
  activityLap,
  activityStream,
  bestEffort,
  garminConnection,
  type NewActivity,
} from "../../src/db/schema";
import { config } from "../../src/lib/config";
import { decrypt } from "../../src/lib/crypto";
import { advisoryLockKey } from "../../src/lib/lock-key";
import { activityDetailLimiter } from "../../src/routes/activities";
import { upsertActivities } from "../../src/services/garmin-sync";
import { importHistoryPage } from "../../src/services/history-import";
import { secondsInZones } from "../../src/services/hr-zone-time";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import {
  connectGarmin,
  createLongRun,
  createUser,
  FIXTURE_ACCOUNT,
  fixtureOf,
  fixturesSentTo,
  garminBundle,
  seedImport,
} from "../seed";
import { CUSTOM_ZONES, createRunWithSeries, garminZones, replaceSeries } from "../seed-hr-zones";

const app = createTestApp();
const PATH = "/api/activities/latest";

afterEach(() => {
  vi.restoreAllMocks();
  activityDetailLimiter.reset();
});

type RunValues = Pick<NewActivity, "garminActivityId" | "startUtc" | "startLocal"> &
  Partial<Omit<NewActivity, "userId">>;

async function insertRun(userId: string, values: RunValues) {
  const [row] = await db
    .insert(activity)
    .values({ userId, type: "running", distanceM: 8000, durationS: 2700, ...values })
    .returning();
  if (!row) throw new Error("insert returned nothing");
  return row;
}

/** Marks a run computed at the current rule with one effort per distance, as a batch stores them. */
async function markComputed(
  userId: string,
  activityId: string,
  efforts: Partial<Record<DistanceKey, number>>,
) {
  await db
    .update(activity)
    .set({ bestEffortsVersion: BEST_EFFORTS_VERSION })
    .where(eq(activity.id, activityId));
  const rows = Object.entries(efforts).map(([distanceKey, timeS]) => ({
    userId,
    activityId,
    distanceKey: distanceKey as DistanceKey,
    timeS,
    startS: 12.5,
  }));
  if (rows.length > 0) await db.insert(bestEffort).values(rows);
}

/** A run whose best efforts a batch computed, with the times given. */
async function computedRun(
  userId: string,
  efforts: Partial<Record<DistanceKey, number>>,
  values: RunValues,
) {
  const run = await insertRun(userId, values);
  await markComputed(userId, run.id, efforts);
  return run;
}

/** The identity of a run with the Garmin id given, starting at 08:00 local (06:00 UTC) on `date`. */
function startingOn(garminActivityId: number, date: string): RunValues {
  return {
    garminActivityId,
    startUtc: new Date(`${date}T06:00:00Z`),
    startLocal: `${date} 08:00:00`,
  };
}

async function latest(agent: Awaited<ReturnType<typeof signedInAgent>>) {
  const response = await agent.get(PATH);
  expect(response.status).toBe(200);
  return latestActivityResponseSchema.parse(response.body).activity;
}

describe("GET /api/activities/latest", () => {
  it("returns null before any run is stored", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.get(PATH);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ activity: null });
  });

  it("returns the stored run in the contract's shape, startLocal as ISO local time", async () => {
    const agent = await signedInAgent(app);
    const run = await createLongRun(await ownerId());

    expect(await latest(agent)).toEqual({
      id: run.id,
      type: "running",
      startUtc: "2026-09-27T06:00:00.000Z",
      startLocal: "2026-09-27T08:00:00",
      tz: null,
      distanceM: 18_000,
      durationS: 6120,
      avgHr: 148,
      maxHr: 166,
      cadence: 168,
      calories: 1150,
      elevationGainM: 142,
      isIndoor: false,
      isManual: false,
      eventType: "uncategorized",
    });
  });

  it("returns the run with the latest start_utc, not the latest inserted or the highest Garmin id", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const newest = await insertRun(userId, {
      garminActivityId: 7,
      startUtc: new Date("2026-09-27T06:00:00Z"),
      startLocal: "2026-09-27 08:00:00",
    });
    await insertRun(userId, {
      garminActivityId: 9,
      startUtc: new Date("2026-09-20T05:45:00Z"),
      startLocal: "2026-09-20 07:45:00",
    });
    await insertRun(userId, {
      garminActivityId: 8,
      startUtc: new Date("2026-09-24T16:30:00Z"),
      startLocal: "2026-09-24 18:30:00",
    });

    expect((await latest(agent))?.id).toBe(newest.id);
  });

  it("keeps the wall-clock start in the run's own zone when its UTC date differs (time zones)", async () => {
    const agent = await signedInAgent(app);
    await insertRun(await ownerId(), {
      garminActivityId: 1,
      // 00:40 in Berlin is still the previous day in UTC.
      startUtc: new Date("2026-08-30T22:40:00Z"),
      startLocal: "2026-08-31 00:40:00",
      tz: "Europe/Berlin",
    });

    expect(await latest(agent)).toMatchObject({
      startUtc: "2026-08-30T22:40:00.000Z",
      startLocal: "2026-08-31T00:40:00",
      tz: "Europe/Berlin",
    });
  });

  it("returns null heart rate and isIndoor for a treadmill run without HR (indoor run, missing HR)", async () => {
    const agent = await signedInAgent(app);
    await insertRun(await ownerId(), {
      garminActivityId: 2,
      type: "treadmill_running",
      startUtc: new Date("2026-09-24T16:30:00Z"),
      startLocal: "2026-09-24 18:30:00",
      avgHr: null,
      maxHr: null,
      cadence: null,
      elevationGainM: null,
      isIndoor: true,
      isManual: true,
    });

    expect(await latest(agent)).toMatchObject({
      type: "treadmill_running",
      avgHr: null,
      maxHr: null,
      cadence: null,
      elevationGainM: null,
      isIndoor: true,
      isManual: true,
    });
  });

  it("never returns another user's run, even a later one", async () => {
    const agent = await signedInAgent(app);
    const other = await createUser("other.runner@example.com");
    await insertRun(other, {
      garminActivityId: 100,
      startUtc: new Date("2026-09-28T06:00:00Z"),
      startLocal: "2026-09-28 08:00:00",
    });

    expect(await latest(agent)).toBeNull();

    const own = await createLongRun(await ownerId());
    expect((await latest(agent))?.id).toBe(own.id);
  });

  it("returns 401 without a session", async () => {
    const response = await request(app).get(PATH);

    expectProblem(response, 401, "unauthorized");
  });
});

describe("GET /api/activities", () => {
  const WEEKS_PATH = "/api/activities";

  /** A runner's month: three weeks with runs around one without. */
  async function seedWeeks(userId: string) {
    const run = (
      garminActivityId: number,
      startLocal: string,
      startUtc: string,
      distanceM: number,
    ) =>
      insertRun(userId, {
        garminActivityId,
        startLocal,
        startUtc: new Date(startUtc),
        distanceM,
        durationS: distanceM * 0.33,
      });
    return {
      longRun: await run(7, "2026-09-27 08:00:00", "2026-09-27T06:00:00Z", 18_000),
      treadmill: await run(6, "2026-09-24 18:30:00", "2026-09-24T16:30:00Z", 8000),
      monday: await run(5, "2026-09-21 06:00:00", "2026-09-21T04:00:00Z", 5000),
      // Sunday 23:30 in New York: Monday in UTC, still the week of 2026-09-14 for the runner.
      sundayNight: await run(4, "2026-09-20 23:30:00", "2026-09-21T03:30:00Z", 6000),
      midweek: await run(3, "2026-09-16 19:00:00", "2026-09-16T17:00:00Z", 6500),
      // Just after midnight in Berlin on Monday: Sunday in UTC, already the runner's new week.
      earlyMonday: await run(1, "2026-08-31 00:40:00", "2026-08-30T22:40:00Z", 5000),
    };
  }

  async function weeksPage(
    agent: Awaited<ReturnType<typeof signedInAgent>>,
    query = "",
  ): Promise<ActivityWeeksResponse> {
    const response = await agent.get(`${WEEKS_PATH}${query}`);
    expect(response.status).toBe(200);
    return activityWeeksResponseSchema.parse(response.body);
  }

  it("groups runs into Monday-start weeks, newest first, with each week's totals", async () => {
    const agent = await signedInAgent(app);
    const runs = await seedWeeks(await ownerId());

    const response = await agent.get(WEEKS_PATH);

    expect(response.headers["cache-control"]).toBe("no-store");
    const body = activityWeeksResponseSchema.parse(response.body);
    expect(body.nextBefore).toBeNull();
    expect(
      body.weeks.map((week) => ({
        weekStart: week.weekStart,
        distanceM: week.distanceM,
        runs: week.runs.map((run) => run.id),
      })),
    ).toEqual([
      {
        weekStart: "2026-09-21",
        distanceM: 31_000,
        runs: [runs.longRun.id, runs.treadmill.id, runs.monday.id],
      },
      { weekStart: "2026-09-14", distanceM: 12_500, runs: [runs.sundayNight.id, runs.midweek.id] },
      { weekStart: "2026-08-31", distanceM: 5000, runs: [runs.earlyMonday.id] },
    ]);
    expect(body.weeks[0]?.durationS).toBeCloseTo(31_000 * 0.33);
    expect(body.weeks[0]?.runs[0]).toMatchObject({
      startLocal: "2026-09-27T08:00:00",
      startUtc: "2026-09-27T06:00:00.000Z",
    });
  });

  it("keeps a run late on Sunday night in its local week, not the UTC one (time zones)", async () => {
    const agent = await signedInAgent(app);
    const runs = await seedWeeks(await ownerId());

    const { weeks } = await weeksPage(agent);

    const weekOf = (id: string) => weeks.find((week) => week.runs.some((run) => run.id === id));
    expect(weekOf(runs.sundayNight.id)?.weekStart).toBe("2026-09-14");
    expect(weekOf(runs.earlyMonday.id)?.weekStart).toBe("2026-08-31");
  });

  it("pages whole weeks: nextBefore leads to the older ones and is null on the last page (pagination)", async () => {
    const agent = await signedInAgent(app);
    await seedWeeks(await ownerId());

    const first = await weeksPage(agent, "?weeks=2");
    const second = await weeksPage(agent, `?weeks=2&before=${first.nextBefore}`);

    expect(first.weeks.map((week) => week.weekStart)).toEqual(["2026-09-21", "2026-09-14"]);
    expect(first.nextBefore).toBe("2026-09-14");
    expect(second.weeks.map((week) => week.weekStart)).toEqual(["2026-08-31"]);
    expect(second.nextBefore).toBeNull();
  });

  it("returns null nextBefore when the page ends exactly at the oldest week", async () => {
    const agent = await signedInAgent(app);
    await seedWeeks(await ownerId());

    const page = await weeksPage(agent, "?weeks=3");

    expect(page.weeks).toHaveLength(3);
    expect(page.nextBefore).toBeNull();
  });

  it("orders runs with the same start by the newer Garmin id first", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const older = await insertRun(userId, {
      garminActivityId: 20,
      startUtc: new Date("2026-09-24T16:30:00Z"),
      startLocal: "2026-09-24 18:30:00",
    });
    const newer = await insertRun(userId, {
      garminActivityId: 21,
      startUtc: new Date("2026-09-24T16:30:00Z"),
      startLocal: "2026-09-24 18:30:00",
    });

    const { weeks } = await weeksPage(agent);

    expect(weeks[0]?.runs.map((run) => run.id)).toEqual([newer.id, older.id]);
  });

  it("returns no weeks and a null nextBefore before any run is stored (empty)", async () => {
    const agent = await signedInAgent(app);

    expect(await weeksPage(agent)).toEqual({ weeks: [], nextBefore: null });
    expect(await weeksPage(agent, "?before=2026-09-14")).toEqual({ weeks: [], nextBefore: null });
  });

  it("lists the whole imported history week by week, each run once (imported count equals Garmin's)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);
    await seedImport(userId);
    for (let page = 0; page < 20; page += 1) {
      const result = await importHistoryPage({ userId, pageSize: 10 });
      if (result.status !== "continued") break;
    }

    const weekStarts: string[] = [];
    const ids = new Set<string>();
    let before: string | null = null;
    do {
      const page: ActivityWeeksResponse = await weeksPage(
        agent,
        `?weeks=26${before ? `&before=${before}` : ""}`,
      );
      for (const week of page.weeks) {
        weekStarts.push(week.weekStart);
        week.runs.forEach((run) => ids.add(run.id));
        expect(week.distanceM).toBeCloseTo(week.runs.reduce((sum, run) => sum + run.distanceM, 0));
      }
      before = page.nextBefore;
    } while (before);

    expect(ids.size).toBe(FIXTURE_ACCOUNT.runs);
    expect(weekStarts.every((start) => new Date(`${start}T00:00:00Z`).getUTCDay() === 1)).toBe(
      true,
    );
    expect([...weekStarts].sort().reverse()).toEqual(weekStarts);
    expect(new Set(weekStarts).size).toBe(weekStarts.length);
  });

  it("carries each run's event type: race, uncategorized, and null for a run stored before event types (race badge)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const race = await insertRun(userId, {
      garminActivityId: 2,
      startUtc: new Date("2026-09-06T05:30:00Z"),
      startLocal: "2026-09-06 07:30:00",
      eventType: RACE_EVENT_TYPE,
    });
    const easy = await insertRun(userId, {
      garminActivityId: 3,
      startUtc: new Date("2026-09-08T05:30:00Z"),
      startLocal: "2026-09-08 07:30:00",
      eventType: "uncategorized",
    });
    const unsynced = await insertRun(userId, {
      garminActivityId: 1,
      startUtc: new Date("2026-08-31T05:30:00Z"),
      startLocal: "2026-08-31 07:30:00",
    });

    const { weeks } = await weeksPage(agent);

    expect(
      weeks.flatMap((week) => week.runs.map((run) => ({ id: run.id, eventType: run.eventType }))),
    ).toEqual([
      { id: easy.id, eventType: "uncategorized" },
      { id: race.id, eventType: RACE_EVENT_TYPE },
      { id: unsynced.id, eventType: null },
    ]);
  });

  it("never lists another user's runs", async () => {
    const agent = await signedInAgent(app);
    const other = await createUser("other.runner@example.com");
    await insertRun(other, {
      garminActivityId: 100,
      startUtc: new Date("2026-09-28T06:00:00Z"),
      startLocal: "2026-09-28 08:00:00",
    });
    const own = await createLongRun(await ownerId());

    const { weeks } = await weeksPage(agent);

    expect(weeks.map((week) => week.runs.map((run) => run.id))).toEqual([[own.id]]);
  });

  it.each([
    ["weeks=0"],
    ["weeks=27"],
    ["weeks=two"],
    ["before=2026-02-30"],
    ["before=last-week"],
    ["page=2"],
  ])("returns 400 validation for the query %s", async (query) => {
    const agent = await signedInAgent(app);

    expectProblem(await agent.get(`${WEEKS_PATH}?${query}`), 400, "validation");
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).get(WEEKS_PATH), 401, "unauthorized");
  });
});

// Run detail against the Garmin service in fixture mode, which serves one sanitized detail for every run of
// the fixture account and derives variants from the list item: 10000000006 a treadmill run (no route, no
// elevation), 10000000004 a run without HR, 10000000003 a manual entry (no samples at all).
const LONG_RUN = 10_000_000_007;
const TREADMILL = 10_000_000_006;
const NO_HR = 10_000_000_004;
const MANUAL = 10_000_000_003;
/** Not in the fixture account: Garmin answers 404, as for a run deleted on Garmin Connect. */
const DELETED_ON_GARMIN = 123;

type Agent = Awaited<ReturnType<typeof signedInAgent>>;

const detailPath = (id: string) => `/api/activities/${id}/detail`;

/** The owner, connected to the fixture Garmin with `bundle`, and one of their runs. */
async function ownerWithRun(garminActivityId = LONG_RUN, bundle = garminBundle()) {
  const agent = await signedInAgent(app);
  const userId = await ownerId();
  await connectGarmin(userId, bundle);
  const run = await createLongRun(userId, garminActivityId);
  return { agent, userId, run };
}

/** A sync storing the fixture long run back from Garmin with its distance edited. */
async function syncEditedLongRun(userId: string): Promise<number> {
  return upsertActivities(userId, [
    {
      garminActivityId: LONG_RUN,
      type: "running",
      startUtc: "2026-09-27T06:00:00Z",
      startLocal: "2026-09-27T08:00:00",
      tz: null,
      distanceM: 18_250,
      durationS: 6120,
      avgHr: 148,
      maxHr: 166,
      cadence: 168,
      calories: 1150,
      elevationGainM: 142,
      isIndoor: false,
      isManual: false,
      eventType: "uncategorized",
    },
  ]);
}

async function fetchDetail(agent: Agent, id: string): Promise<ActivityResponse> {
  const response = await agent.post(detailPath(id));
  expect(response.status).toBe(200);
  return activityResponseSchema.parse(response.body);
}

async function bestEffortsOf(agent: Agent, id: string) {
  const response = await agent.get(`/api/activities/${id}`);
  expect(response.status).toBe(200);
  return activityResponseSchema.parse(response.body).bestEfforts;
}

async function stored() {
  return {
    laps: await db.select().from(activityLap),
    streams: await db.select().from(activityStream),
  };
}

/** Resolves once a caller in this database waits in Postgres for an advisory lock another connection holds. */
async function aCallerWaitsForTheLock(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await db.execute<{ count: string }>(
      sql`select count(*) from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
    );
    if (Number(result.rows[0]?.count) > 0) return;
    await sleep(20);
  }
  throw new Error("no caller waited for the lock");
}

async function storedConnection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection stored");
  return row;
}

describe("GET /api/activities/:id", () => {
  it("returns the run in the contract's shape with detail null before a fetch", async () => {
    const agent = await signedInAgent(app);
    const run = await createLongRun(await ownerId());

    const response = await agent.get(`/api/activities/${run.id}`);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(activityResponseSchema.parse(response.body)).toEqual({
      activity: {
        id: run.id,
        type: "running",
        startUtc: "2026-09-27T06:00:00.000Z",
        startLocal: "2026-09-27T08:00:00",
        tz: null,
        distanceM: 18_000,
        durationS: 6120,
        avgHr: 148,
        maxHr: 166,
        cadence: 168,
        calories: 1150,
        elevationGainM: 142,
        isIndoor: false,
        isManual: false,
        eventType: "uncategorized",
      },
      detail: null,
      // Not computed yet.
      bestEfforts: [],
      shoeId: null,
    });
  });

  it("returns eventType race for a run the runner marked a race on Garmin (race badge)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const run = await createLongRun(userId);
    await db.update(activity).set({ eventType: RACE_EVENT_TYPE }).where(eq(activity.id, run.id));

    const response = await agent.get(`/api/activities/${run.id}`);

    expect(response.status).toBe(200);
    expect(activityResponseSchema.parse(response.body).activity.eventType).toBe(RACE_EVENT_TYPE);
    expect((await latest(agent))?.eventType).toBe(RACE_EVENT_TYPE);
  });

  it("returns the stored detail once it was fetched, without calling Garmin", async () => {
    const { agent, run } = await ownerWithRun();
    const fetched = await fetchDetail(agent, run.id);
    const sent = fixturesSentTo("/detail");

    const response = await agent.get(`/api/activities/${run.id}`);

    expect(response.status).toBe(200);
    expect(activityResponseSchema.parse(response.body)).toEqual(fetched);
    expect(fetched.detail).not.toBeNull();
    expect(sent()).toEqual([]);
  });

  it("answers the run's best efforts shortest first, each a personal best where no run is faster (personal bests)", async () => {
    const agent = await signedInAgent(app);
    const run = await computedRun(
      await ownerId(),
      { half: 7012.125, "1k": 301, "10k": 3290.5, "1mi": 489.75, "5k": 1625.25 },
      startingOn(1, "2026-09-20"),
    );

    expect(await bestEffortsOf(agent, run.id)).toEqual([
      { distanceKey: "1k", timeS: 301, personalBest: true },
      { distanceKey: "1mi", timeS: 489.75, personalBest: true },
      { distanceKey: "5k", timeS: 1625.25, personalBest: true },
      { distanceKey: "10k", timeS: 3290.5, personalBest: true },
      { distanceKey: "half", timeS: 7012.125, personalBest: true },
    ]);
  });

  it("answers personalBest false at a distance a later run beat and true where the run still holds the best (personal bests)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const older = await computedRun(
      userId,
      { "1k": 301, "5k": 1625.25, "10k": 3290.5 },
      startingOn(1, "2026-08-02"),
    );
    const newer = await computedRun(
      userId,
      { "1k": 305, "5k": 1601.75 },
      startingOn(2, "2026-09-20"),
    );

    expect(await bestEffortsOf(agent, older.id)).toEqual([
      { distanceKey: "1k", timeS: 301, personalBest: true },
      { distanceKey: "5k", timeS: 1625.25, personalBest: false },
      { distanceKey: "10k", timeS: 3290.5, personalBest: true },
    ]);
    expect(await bestEffortsOf(agent, newer.id)).toEqual([
      { distanceKey: "1k", timeS: 305, personalBest: false },
      { distanceKey: "5k", timeS: 1601.75, personalBest: true },
    ]);
  });

  it("gives an exact tie to the earlier run, and at the same start to the lower Garmin id (duplicate activities)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const later = await computedRun(userId, { "5k": 1600 }, startingOn(30, "2026-09-20"));
    const twinSavedSecond = await computedRun(userId, { "5k": 1600 }, startingOn(32, "2026-09-10"));
    const twin = await computedRun(userId, { "5k": 1600 }, startingOn(31, "2026-09-10"));
    const flags = async (id: string) =>
      (await bestEffortsOf(agent, id)).map((effort) => effort.personalBest);

    expect(await flags(later.id)).toEqual([false]);
    expect(await flags(twinSavedSecond.id)).toEqual([false]);
    expect(await flags(twin.id)).toEqual([true]);
  });

  it.each([
    ["treadmill", { type: "treadmill_running", isIndoor: true }],
    ["virtual", { type: "virtual_run", isIndoor: true }],
    ["manual", { isManual: true }],
    ["sub-1 km", { distanceM: 999, durationS: 330 }],
  ] as const)(
    "answers no efforts for a %s run, even with stored rows, and it takes no best from an outdoor run (treadmill and manual runs)",
    async (_, values) => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      const outdoor = await computedRun(userId, { "1k": 330 }, startingOn(1, "2026-09-20"));
      const left = await computedRun(
        userId,
        { "1k": 290 },
        { ...startingOn(2, "2026-09-21"), ...values },
      );

      expect(await bestEffortsOf(agent, left.id)).toEqual([]);
      expect(await bestEffortsOf(agent, outdoor.id)).toEqual([
        { distanceKey: "1k", timeS: 330, personalBest: true },
      ]);
    },
  );

  it("answers no efforts once a sync rewrites the run's distance, and the next fastest run holds the best until they are computed again (edited activity)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const other = await computedRun(userId, { "5k": 1700 }, startingOn(1, "2026-09-20"));
    const run = await createLongRun(userId);
    await markComputed(userId, run.id, { "5k": 1500 });
    expect(await bestEffortsOf(agent, run.id)).toEqual([
      { distanceKey: "5k", timeS: 1500, personalBest: true },
    ]);

    expect(await syncEditedLongRun(userId)).toBe(1);

    expect(await bestEffortsOf(agent, run.id)).toEqual([]);
    expect(await bestEffortsOf(agent, other.id)).toEqual([
      { distanceKey: "5k", timeS: 1700, personalBest: true },
    ]);
  });

  it("answers no efforts for a run not computed yet or computed without any (partial backfill)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const pending = await insertRun(userId, startingOn(1, "2026-09-20"));
    const empty = await computedRun(userId, {}, startingOn(2, "2026-09-21"));

    expect(await bestEffortsOf(agent, pending.id)).toEqual([]);
    expect(await bestEffortsOf(agent, empty.id)).toEqual([]);
  });

  it("keeps answering efforts from an older rule version while they wait to be recomputed", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const run = await computedRun(userId, { "1k": 290 }, startingOn(1, "2026-09-20"));
    await db
      .update(activity)
      .set({ bestEffortsVersion: BEST_EFFORTS_VERSION - 1 })
      .where(eq(activity.id, run.id));

    expect(await bestEffortsOf(agent, run.id)).toEqual([
      { distanceKey: "1k", timeS: 290, personalBest: true },
    ]);
  });

  it("never weighs another runner's faster efforts", async () => {
    const agent = await signedInAgent(app);
    const other = await createUser("other.runner@example.com");
    await computedRun(other, { "5k": 1400 }, startingOn(1, "2026-09-10"));
    const own = await computedRun(await ownerId(), { "5k": 1700 }, startingOn(2, "2026-09-20"));

    expect(await bestEffortsOf(agent, own.id)).toEqual([
      { distanceKey: "5k", timeS: 1700, personalBest: true },
    ]);
  });

  it("returns 404 not_found for an unknown id", async () => {
    const agent = await signedInAgent(app);

    expectProblem(await agent.get(`/api/activities/${randomUUID()}`), 404, ErrorCode.notFound);
  });

  it("returns 404 not_found for another user's run", async () => {
    const agent = await signedInAgent(app);
    const other = await createLongRun(await createUser("other.runner@example.com"));

    const response = await agent.get(`/api/activities/${other.id}`);

    expectProblem(response, 404, ErrorCode.notFound);
    expect(response.text).not.toContain("18000");
  });

  it("returns 400 validation for an id that is not a uuid", async () => {
    const agent = await signedInAgent(app);

    expectProblem(await agent.get("/api/activities/not-a-uuid"), 400, ErrorCode.validation);
  });

  it("still serves /api/activities/latest rather than reading latest as an id", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.get(PATH);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ activity: null });
  });

  it("returns 401 without a session", async () => {
    const response = await request(app).get(`/api/activities/${randomUUID()}`);

    expectProblem(response, 401, ErrorCode.unauthorized);
  });
});

describe("POST /api/activities/:id/detail", () => {
  it("fetches the detail from Garmin, stores laps and samples once and answers them (run detail)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), { lastError: ErrorCode.garminUnavailable });
    const run = await createLongRun(userId);
    const sent = fixturesSentTo("/detail");

    const response = await agent.post(detailPath(run.id));

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = activityResponseSchema.parse(response.body);
    expect(body.activity.id).toBe(run.id);
    const detail = body.detail;
    if (!detail) throw new Error("no detail");
    expect(detail.laps).toHaveLength(17);
    expect(detail.laps.map((lap) => lap.index)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
    expect(detail.laps[0]).toEqual({
      index: 1,
      distanceM: 1000,
      durationS: 390.422,
      avgHr: 167,
      avgCadence: 145.515625,
    });
    const { streams } = detail;
    expect(streams.elapsedS.length).toBeGreaterThan(500);
    for (const series of Object.values(streams)) {
      expect(series).toHaveLength(streams.elapsedS.length);
    }
    expect(detail.route?.length).toBeGreaterThan(0);
    expect(detail.hrZones?.map((zone) => zone.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(sent()).toEqual([undefined]);
    const rows = await stored();
    expect(rows.laps).toHaveLength(17);
    expect(rows.streams).toHaveLength(1);
    // A finished Garmin call marks the login working, as a sync does.
    expect(await storedConnection(userId)).toMatchObject({ status: "ok", lastError: null });
  });

  it("answers the run's best efforts with their personal-best flags beside the fetched detail (run detail)", async () => {
    const { agent, userId, run } = await ownerWithRun();
    await markComputed(userId, run.id, { "5k": 1625.25, "1k": 301 });
    await computedRun(userId, { "1k": 290 }, startingOn(1, "2026-09-20"));

    const body = await fetchDetail(agent, run.id);

    expect(body.detail).not.toBeNull();
    expect(body.bestEfforts).toEqual([
      { distanceKey: "1k", timeS: 301, personalBest: false },
      { distanceKey: "5k", timeS: 1625.25, personalBest: true },
    ]);
  });

  it("answers the stored detail on a second POST and calls Garmin no more (double tap)", async () => {
    const { agent, run } = await ownerWithRun();
    const first = await fetchDetail(agent, run.id);
    const before = await stored();
    const sent = fixturesSentTo("/detail");

    const second = await fetchDetail(agent, run.id);

    expect(second).toEqual(first);
    expect(sent()).toEqual([]);
    expect(await stored()).toEqual(before);
  });

  it("stores one stream row and calls Garmin once for two concurrent POSTs of one run (double tap)", async () => {
    const { agent, run } = await ownerWithRun();
    const sent = fixturesSentTo("/detail");

    const [first, second] = await Promise.all([
      agent.post(detailPath(run.id)),
      agent.post(detailPath(run.id)),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body).toEqual(second.body);
    expect(sent()).toHaveLength(1);
    const rows = await stored();
    expect(rows.streams).toHaveLength(1);
    expect(rows.laps).toHaveLength(17);
  });

  it("answers hr and zones null for a run without heart rate (missing HR)", async () => {
    const { agent, run } = await ownerWithRun(NO_HR);

    const { detail } = await fetchDetail(agent, run.id);

    expect(detail?.streams.hr).toBeNull();
    expect(detail?.hrZones).toBeNull();
    expect(detail?.streams.elapsedS.length).toBeGreaterThan(0);
    expect(detail?.laps.every((lap) => lap.avgHr === null)).toBe(true);
  });

  it("answers no route and no elevation for a treadmill run (indoor run)", async () => {
    const { agent, run } = await ownerWithRun(TREADMILL);

    const { detail } = await fetchDetail(agent, run.id);

    expect(detail?.route).toBeNull();
    expect(detail?.streams.elevationM).toBeNull();
    expect(detail?.streams.elapsedS.length).toBeGreaterThan(0);
    expect(detail?.laps.length).toBeGreaterThan(0);
  });

  it("stores empty samples for a manual entry and does not ask Garmin again (manual entry)", async () => {
    const { agent, run } = await ownerWithRun(MANUAL);

    const { detail } = await fetchDetail(agent, run.id);
    const sent = fixturesSentTo("/detail");
    const again = await fetchDetail(agent, run.id);

    expect(detail).toEqual({
      laps: [],
      streams: {
        elapsedS: [],
        distanceM: [],
        hr: null,
        cadence: null,
        elevationM: null,
        speedMps: null,
      },
      route: null,
      hrZones: null,
    });
    expect(again.detail).toEqual(detail);
    expect(sent()).toEqual([]);
    expect((await stored()).streams).toHaveLength(1);
  });

  it("keeps the detail when a sync rewrites the run edited on Garmin (edited activity)", async () => {
    const { agent, userId, run } = await ownerWithRun();
    const { detail } = await fetchDetail(agent, run.id);

    const written = await syncEditedLongRun(userId);

    expect(written).toBe(1);
    const response = await agent.get(`/api/activities/${run.id}`);
    const body = activityResponseSchema.parse(response.body);
    expect(body.activity.distanceM).toBe(18_250);
    expect(body.detail).toEqual(detail);
  });

  it("deletes the stored detail with its run", async () => {
    const { agent, run } = await ownerWithRun();
    await fetchDetail(agent, run.id);

    await db.delete(activity).where(eq(activity.id, run.id));

    expect(await stored()).toEqual({ laps: [], streams: [] });
    expectProblem(await agent.get(`/api/activities/${run.id}`), 404, ErrorCode.notFound);
  });

  it("returns 404 not_found and stores nothing when Garmin no longer has the run (deleted on Garmin)", async () => {
    const { agent, userId, run } = await ownerWithRun(DELETED_ON_GARMIN);
    // A first expiry strike stands until a call finishes; Garmin's 404 came from a working login.
    await db
      .update(garminConnection)
      .set({ lastError: ErrorCode.garminAuthExpired })
      .where(eq(garminConnection.userId, userId));

    const response = await agent.post(detailPath(run.id));

    const problem = expectProblem(response, 404, ErrorCode.notFound);
    expect(problem.detail).toBe("That run is no longer on Garmin Connect.");
    expect(await stored()).toEqual({ laps: [], streams: [] });
    expect(await storedConnection(userId)).toMatchObject({ status: "ok", lastError: null });
  });

  it("returns 404 not_found and calls no Garmin when a sync removes the run between the read and the lock (deleted on Garmin)", async () => {
    const { agent, userId, run } = await ownerWithRun();
    const sent = fixturesSentTo("/detail");
    // A sync in another process holds the runner's lock and removes the run Garmin no longer lists.
    const sync = new pg.Client({ connectionString: config.DATABASE_URL });
    await sync.connect();
    try {
      await sync.query("begin");
      await sync.query("select pg_advisory_xact_lock($1::bigint)", [
        advisoryLockKey("user", userId),
      ]);
      // then() sends the request; it reads the run, then waits behind the sync's lock.
      const pending = agent.post(detailPath(run.id)).then((response) => response);
      await aCallerWaitsForTheLock();
      await sync.query("delete from activity where id = $1", [run.id]);
      await sync.query("commit");

      const response = await pending;

      const problem = expectProblem(response, 404, ErrorCode.notFound);
      expect(problem.detail).toBe("That run does not exist.");
      expect(sent()).toEqual([]);
      expect(await stored()).toEqual({ laps: [], streams: [] });
    } finally {
      await sync.end();
    }
  });

  it("returns 404 not_found for an unknown id or another user's run without calling Garmin", async () => {
    const { agent } = await ownerWithRun();
    const other = await createLongRun(await createUser("other.runner@example.com"));
    const sent = fixturesSentTo("/detail");

    expectProblem(await agent.post(detailPath(randomUUID())), 404, ErrorCode.notFound);
    expectProblem(await agent.post(detailPath(other.id)), 404, ErrorCode.notFound);
    expect(sent()).toEqual([]);
    expect(await stored()).toEqual({ laps: [], streams: [] });
  });

  it("returns 400 validation for an id that is not a uuid", async () => {
    const agent = await signedInAgent(app);

    expectProblem(await agent.post(detailPath("not-a-uuid")), 400, ErrorCode.validation);
  });

  it("returns 409 garmin_not_connected without a Garmin connection", async () => {
    const agent = await signedInAgent(app);
    const run = await createLongRun(await ownerId());
    const sent = fixturesSentTo("/detail");

    expectProblem(await agent.post(detailPath(run.id)), 409, ErrorCode.garminNotConnected);
    expect(sent()).toEqual([]);
  });

  it("returns 409 garmin_auth_expired and stores nothing when Garmin rejects the bundle (token expiry)", async () => {
    const { agent, userId, run } = await ownerWithRun(LONG_RUN, garminBundle("expired"));

    const response = await agent.post(detailPath(run.id));

    expectProblem(response, 409, ErrorCode.garminAuthExpired);
    expect(await stored()).toEqual({ laps: [], streams: [] });
    expect((await storedConnection(userId)).lastError).toBe(ErrorCode.garminAuthExpired);
  });

  it("returns 429 with Retry-After and stores nothing, then refuses the next POST for the hour without calling Garmin (Garmin 429)", async () => {
    const { agent, run } = await ownerWithRun(LONG_RUN, garminBundle("rate_limited"));
    const sent = fixturesSentTo("/detail");

    const first = await agent.post(detailPath(run.id));
    const second = await agent.post(detailPath(run.id));

    expect(expectProblem(first, 429, ErrorCode.garminRateLimited).retryAfterSeconds).toBe(3600);
    expect(first.headers["retry-after"]).toBe("3600");
    const refused = expectProblem(second, 429, ErrorCode.garminRateLimited);
    expect(refused.retryAfterSeconds).toBeGreaterThan(3500);
    expect(second.headers["retry-after"]).toBe(String(refused.retryAfterSeconds));
    expect(sent()).toEqual(["rate_limited"]);
    expect(await stored()).toEqual({ laps: [], streams: [] });
  });

  it("returns 502 garmin_unavailable and stores nothing when Garmin is down (Garmin outage)", async () => {
    const { agent, userId, run } = await ownerWithRun(LONG_RUN, garminBundle("unavailable"));

    const response = await agent.post(detailPath(run.id));

    expectProblem(response, 502, ErrorCode.garminUnavailable);
    expect(await stored()).toEqual({ laps: [], streams: [] });
    expect((await storedConnection(userId)).lastError).toBe(ErrorCode.garminUnavailable);
  });

  it("writes the bundle Garmin rotated back, encrypted (rotated token)", async () => {
    const { agent, userId, run } = await ownerWithRun(LONG_RUN, garminBundle("rotate"));

    await fetchDetail(agent, run.id);

    const { tokenBundleEnc } = await storedConnection(userId);
    expect(tokenBundleEnc.startsWith("v1:")).toBe(true);
    expect(fixtureOf(decrypt(tokenBundleEnc, userId))).toBe("rotated");
  });

  it("keeps the bundle Garmin rotated before a 502 and stores nothing (rotate then 502)", async () => {
    const { agent, userId, run } = await ownerWithRun(
      LONG_RUN,
      garminBundle("rotate_then_unavailable"),
    );

    expectProblem(await agent.post(detailPath(run.id)), 502, ErrorCode.garminUnavailable);

    const { tokenBundleEnc } = await storedConnection(userId);
    expect(fixtureOf(decrypt(tokenBundleEnc, userId))).toBe("rotated");
    expect(await stored()).toEqual({ laps: [], streams: [] });
  });

  it("returns 401 without a session and calls no Garmin", async () => {
    const sent = fixturesSentTo("/detail");

    const response = await request(app).post(detailPath(randomUUID()));

    expectProblem(response, 401, ErrorCode.unauthorized);
    expect(sent()).toEqual([]);
  });

  it("returns 429 rate_limited on the 7th call in a minute without calling Garmin", async () => {
    const { agent, run } = await ownerWithRun();
    for (let call = 0; call < 6; call += 1) {
      expect((await agent.post(detailPath(run.id))).status).toBe(200);
    }
    const sent = fixturesSentTo("/detail");

    const response = await agent.post(detailPath(run.id));

    const problem = expectProblem(response, 429, ErrorCode.rateLimited);
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(problem.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(response.headers["retry-after"]).toBe(String(problem.retryAfterSeconds));
    expect(sent()).toEqual([]);
  });
});

// Seconds in zone with the runner's own zones (slice 12a): computed from the stored series on every read.
// CUSTOM_ZONES' floors are 100, 120, 140, 160 and 180 bpm; each sample holds until the next.
const ZONE_SERIES = {
  elapsedS: [0, 10, 20, 35, 50, 60.4, 90.4, 100],
  hr: [95, 120, 130, null, 150, 175, 181, 160],
};
/** ZONE_SERIES in CUSTOM_ZONES: 10 s below zone 1, 15 s without a reading, the last sample adds nothing. */
const ZONE_SERIES_SECONDS = [
  { zone: 1, lowBpm: 100, seconds: 0 },
  { zone: 2, lowBpm: 120, seconds: 25 },
  { zone: 3, lowBpm: 140, seconds: 10 },
  { zone: 4, lowBpm: 160, seconds: 30 },
  { zone: 5, lowBpm: 180, seconds: 10 },
];
/** What Garmin stored for the run: its own floors and seconds. */
const GARMIN_STORED = garminZones([98, 117, 137, 156, 176], [11, 22, 33, 44, 55]);
const ROUTE: [number, number][] = [
  [0, -30],
  [0.001, -30],
];

async function zonesOfRun(agent: Agent, id: string) {
  const response = await agent.get(`/api/activities/${id}`);
  expect(response.status).toBe(200);
  return activityResponseSchema.parse(response.body).detail?.hrZones;
}

async function saveCustomZones(agent: Agent) {
  expect((await agent.put("/api/hr-zones").send(CUSTOM_ZONES)).status).toBe(200);
}

describe("GET /api/activities/:id with custom heart-rate zones", () => {
  it("computes each zone's seconds from the stored HR series with custom zones (custom zones)", async () => {
    const agent = await signedInAgent(app);
    const run = await createRunWithSeries(await ownerId(), {
      ...ZONE_SERIES,
      hrZones: GARMIN_STORED,
      route: ROUTE,
    });
    await saveCustomZones(agent);

    expect(await zonesOfRun(agent, run.id)).toEqual(ZONE_SERIES_SECONDS);
  });

  it("answers Garmin's stored seconds unchanged without custom zones", async () => {
    const agent = await signedInAgent(app);
    const run = await createRunWithSeries(await ownerId(), {
      ...ZONE_SERIES,
      hrZones: GARMIN_STORED,
    });

    expect(await zonesOfRun(agent, run.id)).toEqual(GARMIN_STORED);
  });

  it("answers Garmin's stored seconds again after Reset to Garmin's", async () => {
    const agent = await signedInAgent(app);
    const run = await createRunWithSeries(await ownerId(), {
      ...ZONE_SERIES,
      hrZones: GARMIN_STORED,
    });
    await saveCustomZones(agent);
    expect(await zonesOfRun(agent, run.id)).toEqual(ZONE_SERIES_SECONDS);

    expect((await agent.delete("/api/hr-zones")).status).toBe(200);

    expect(await zonesOfRun(agent, run.id)).toEqual(GARMIN_STORED);
  });

  it.each([
    ["no heart-rate series", null],
    ["a series without a reading", [null, null, null]],
  ])("answers hrZones null with custom zones for a run with %s (missing HR)", async (_case, hr) => {
    const agent = await signedInAgent(app);
    const run = await createRunWithSeries(await ownerId(), {
      elapsedS: [0, 10, 20],
      hr,
      hrZones: null,
    });
    await saveCustomZones(agent);

    const response = await agent.get(`/api/activities/${run.id}`);

    expect(response.status).toBe(200);
    const { detail } = activityResponseSchema.parse(response.body);
    expect(detail?.hrZones).toBeNull();
    expect(detail?.streams.elapsedS).toEqual([0, 10, 20]);
  });

  it("computes a treadmill run's zones like an outdoor run's (indoor run)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const outdoor = await createRunWithSeries(userId, {
      ...ZONE_SERIES,
      hrZones: GARMIN_STORED,
      route: ROUTE,
    });
    const treadmill = await createRunWithSeries(
      userId,
      { ...ZONE_SERIES, hrZones: GARMIN_STORED, route: null },
      { type: "treadmill_running", isIndoor: true },
    );
    await saveCustomZones(agent);

    expect(await zonesOfRun(agent, treadmill.id)).toEqual(ZONE_SERIES_SECONDS);
    expect(await zonesOfRun(agent, outdoor.id)).toEqual(ZONE_SERIES_SECONDS);
  });

  it("follows the stored series when the run's detail is stored again (duplicate or edited activity)", async () => {
    const agent = await signedInAgent(app);
    const run = await createRunWithSeries(await ownerId(), {
      ...ZONE_SERIES,
      hrZones: GARMIN_STORED,
    });
    await saveCustomZones(agent);
    expect(await zonesOfRun(agent, run.id)).toEqual(ZONE_SERIES_SECONDS);

    await replaceSeries(run.id, {
      elapsedS: [0, 40, 100, 160],
      hr: [110, 165, 185, 185],
      hrZones: GARMIN_STORED,
    });

    expect((await zonesOfRun(agent, run.id))?.map((zone) => zone.seconds)).toEqual([
      40, 0, 0, 60, 60,
    ]);
  });

  it("answers zones computed from the fetched series in the detail fetch (run detail)", async () => {
    const { agent, run } = await ownerWithRun();
    await saveCustomZones(agent);

    const { detail } = await fetchDetail(agent, run.id);

    if (!detail) throw new Error("no detail");
    const [stream] = await db.select().from(activityStream);
    expect(detail.hrZones).toEqual(
      secondsInZones(stream!.elapsedS, stream!.hr, CUSTOM_ZONES.lowBpm),
    );
    expect(detail.hrZones?.map((zone) => zone.lowBpm)).toEqual(CUSTOM_ZONES.lowBpm);
    expect(detail.hrZones).not.toEqual(stream!.hrZones);
    expect(detail.hrZones?.reduce((sum, zone) => sum + zone.seconds, 0)).toBeGreaterThan(0);
  });

  it("uses only the signed-in runner's custom zones", async () => {
    const other = await signedInAgent(app, {
      email: "other@example.com",
      password: "another-horse-battery-staple",
      name: "Other Runner",
    });
    await saveCustomZones(other);
    const agent = await signedInAgent(app);
    const run = await createRunWithSeries(await ownerId(), {
      ...ZONE_SERIES,
      hrZones: GARMIN_STORED,
    });

    expect(await zonesOfRun(agent, run.id)).toEqual(GARMIN_STORED);
  });
});
