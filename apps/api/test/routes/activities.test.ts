import {
  type ActivityWeeksResponse,
  activityWeeksResponseSchema,
  latestActivityResponseSchema,
} from "@running-coach/shared";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity, type NewActivity } from "../../src/db/schema";
import { importHistoryPage } from "../../src/services/history-import";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { connectGarmin, createLongRun, createUser, FIXTURE_ACCOUNT, seedImport } from "../seed";

const app = createTestApp();
const PATH = "/api/activities/latest";

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
      elevationGainM: 142,
      isIndoor: false,
      isManual: false,
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
