import { latestActivityResponseSchema } from "@running-coach/shared";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity, type NewActivity } from "../../src/db/schema";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { createLongRun, createUser } from "../seed";

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
