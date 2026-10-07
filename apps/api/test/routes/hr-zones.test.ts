import { type HrZones, type HrZonesResponse, hrZonesResponseSchema } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { userSettings } from "../../src/db/schema";
import { browserAgent, createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { createRunOn, setSettings } from "../seed";
import { CUSTOM_ZONES, createRunWithSeries, garminZones } from "../seed-hr-zones";

// /api/hr-zones on the real Postgres (Settings > Heart-rate zones, slice 12a). Garmin's zones are read from
// the stored details, never fetched: the routes call no Garmin. The estimate reads runs of the last 365
// days, so those tests pin the clock (Date only, timers run).

const app = createTestApp();
const PATH = "/api/hr-zones";

const OTHER_USER = {
  email: "other@example.com",
  password: "another-horse-battery-staple",
  name: "Other Runner",
} as const;

/** Garmin's floors on a newer run: max HR read back as 176 / 0.9 = 195.6, so 196. */
const GARMIN_FLOORS = [97.6, 117.2, 136.8, 156.4, 176];
const GARMIN_ZONES: HrZones = { maxHr: 196, lowBpm: [98, 117, 137, 156, 176] };

/** A short series with heart rate, as any run's stored detail. */
const SERIES = { elapsedS: [0, 60, 120], hr: [130, 150, 160] };

afterEach(() => {
  vi.useRealTimers();
});

function clockAt(now: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

type Agent = Awaited<ReturnType<typeof signedInAgent>>;

/** A client without a session cookie. */
function signedOut() {
  return browserAgent(app);
}

async function zonesOf(agent: Agent): Promise<HrZonesResponse> {
  const response = await agent.get(PATH);
  expect(response.status).toBe(200);
  return hrZonesResponseSchema.parse(response.body);
}

async function storedZones(userId: string): Promise<unknown> {
  const [row] = await db
    .select({ hrZones: userSettings.hrZones })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return row?.hrZones;
}

/** The owner signed in, with a run whose stored detail carries Garmin's zones at GARMIN_FLOORS. */
async function ownerWithGarminZones() {
  const agent = await signedInAgent(app);
  const userId = await ownerId();
  await createRunWithSeries(
    userId,
    { ...SERIES, hrZones: garminZones(GARMIN_FLOORS) },
    { startUtc: new Date("2026-09-27T06:00:00Z"), startLocal: "2026-09-27 08:00:00" },
  );
  return { agent, userId };
}

describe("GET /api/hr-zones", () => {
  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().get(PATH), 401, "unauthorized");
  });

  it("answers none for a runner without runs", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.get(PATH);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(hrZonesResponseSchema.parse(response.body)).toEqual({ source: "none", zones: null });
  });

  it("answers none when no run has a max HR (missing HR)", async () => {
    const agent = await signedInAgent(app);
    await createRunOn(await ownerId(), "2026-09-27", { maxHr: null, isIndoor: true });

    expect(await zonesOf(agent)).toEqual({ source: "none", zones: null });
  });

  it("estimates Garmin's default shares of the highest max HR of the last 365 days, an older higher run ignored", async () => {
    clockAt(new Date("2026-10-07T12:00:00Z"));
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await createRunOn(userId, "2026-09-27", { maxHr: 181 });
    await createRunOn(userId, "2025-10-08", { maxHr: 188 });
    await createRunOn(userId, "2025-10-06", { maxHr: 201 });
    await createRunOn(userId, "2026-10-01", { maxHr: null });

    expect(await zonesOf(agent)).toEqual({
      source: "estimated",
      // 50, 60, 70, 80 and 90% of 188.
      zones: { maxHr: 188, lowBpm: [94, 113, 132, 150, 169] },
    });
  });

  it("estimates from a run's detail without Garmin's zones as from one never opened (missing HR)", async () => {
    clockAt(new Date("2026-10-07T12:00:00Z"));
    const agent = await signedInAgent(app);
    await createRunWithSeries(
      await ownerId(),
      { elapsedS: [0, 60], hr: null, hrZones: null },
      { maxHr: 172 },
    );

    expect((await zonesOf(agent)).source).toBe("estimated");
  });

  it("clamps an estimated max HR from an optical spike to 240 bpm", async () => {
    clockAt(new Date("2026-10-07T12:00:00Z"));
    const agent = await signedInAgent(app);
    await createRunOn(await ownerId(), "2026-09-27", { maxHr: 251 });

    expect(await zonesOf(agent)).toEqual({
      source: "estimated",
      zones: { maxHr: 240, lowBpm: [120, 144, 168, 192, 216] },
    });
  });

  it("answers Garmin's zones from the newest run that carries them when two runs carry different floors, max HR from zone 5's floor", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    // Inserted first, started last: the start decides, not the insert.
    await createRunWithSeries(
      userId,
      { ...SERIES, hrZones: garminZones(GARMIN_FLOORS) },
      { startUtc: new Date("2026-09-27T06:00:00Z"), startLocal: "2026-09-27 08:00:00" },
    );
    await createRunWithSeries(
      userId,
      { ...SERIES, hrZones: garminZones([90, 108, 126, 144, 162]) },
      { startUtc: new Date("2026-09-20T06:00:00Z"), startLocal: "2026-09-20 08:00:00", maxHr: 205 },
    );
    // Newer still, but without heart rate: Garmin sent no zones for it.
    await createRunWithSeries(
      userId,
      { elapsedS: [0, 60], hr: null, hrZones: null },
      { startUtc: new Date("2026-09-30T06:00:00Z"), startLocal: "2026-09-30 08:00:00" },
    );

    expect(await zonesOf(agent)).toEqual({ source: "garmin", zones: GARMIN_ZONES });
  });

  it("estimates when the newest run's stored zones do not make five rising floors", async () => {
    clockAt(new Date("2026-10-07T12:00:00Z"));
    const agent = await signedInAgent(app);
    await createRunWithSeries(
      await ownerId(),
      { ...SERIES, hrZones: garminZones([0, 0, 0, 0, 0]) },
      { startUtc: new Date("2026-09-27T06:00:00Z"), startLocal: "2026-09-27 08:00:00", maxHr: 180 },
    );

    expect(await zonesOf(agent)).toEqual({
      source: "estimated",
      zones: { maxHr: 180, lowBpm: [90, 108, 126, 144, 162] },
    });
  });

  it("answers Garmin's zones, not an error, when the stored custom zones no longer parse", async () => {
    const { agent, userId } = await ownerWithGarminZones();
    await setSettings(userId, { hrZones: { maxHr: 150, lowBpm: [1, 2] } as unknown as HrZones });

    expect(await zonesOf(agent)).toEqual({ source: "garmin", zones: GARMIN_ZONES });
  });

  it("never reads another runner's zones or runs", async () => {
    clockAt(new Date("2026-10-07T12:00:00Z"));
    const other = await signedInAgent(app, OTHER_USER);
    const otherId = await ownerId(OTHER_USER.email);
    await createRunWithSeries(otherId, { ...SERIES, hrZones: garminZones(GARMIN_FLOORS) });
    await createRunOn(otherId, "2026-09-28", { maxHr: 190 });
    expect((await other.put(PATH).send(CUSTOM_ZONES)).status).toBe(200);
    const owner = await signedInAgent(app);

    expect(await zonesOf(owner)).toEqual({ source: "none", zones: null });
    expect(await zonesOf(other)).toEqual({ source: "custom", zones: CUSTOM_ZONES });
  });
});

describe("PUT /api/hr-zones", () => {
  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().put(PATH).send(CUSTOM_ZONES), 401, "unauthorized");
  });

  it("saves custom zones over Garmin's and answers them, persisted for the next read", async () => {
    const { agent, userId } = await ownerWithGarminZones();

    const response = await agent.put(PATH).send(CUSTOM_ZONES);

    expect(response.status).toBe(200);
    expect(hrZonesResponseSchema.parse(response.body)).toEqual({
      source: "custom",
      zones: CUSTOM_ZONES,
    });
    expect(await storedZones(userId)).toEqual(CUSTOM_ZONES);
    expect(await zonesOf(agent)).toEqual({ source: "custom", zones: CUSTOM_ZONES });
  });

  it("saves custom zones for a runner without runs", async () => {
    const agent = await signedInAgent(app);

    expect((await agent.put(PATH).send(CUSTOM_ZONES)).status).toBe(200);
    expect(await zonesOf(agent)).toEqual({ source: "custom", zones: CUSTOM_ZONES });
  });

  it("replaces zones saved before", async () => {
    const agent = await signedInAgent(app);
    await agent.put(PATH).send(CUSTOM_ZONES);
    const changed: HrZones = { maxHr: 190, lowBpm: [95, 114, 133, 152, 171] };

    const response = await agent.put(PATH).send(changed);

    expect(hrZonesResponseSchema.parse(response.body)).toEqual({
      source: "custom",
      zones: changed,
    });
    expect(await storedZones(await ownerId())).toEqual(changed);
  });

  it.each([
    ["non-rising floors", { maxHr: 200, lowBpm: [100, 120, 120, 160, 180] }],
    ["floors out of order", { maxHr: 200, lowBpm: [100, 140, 120, 160, 180] }],
    ["zone 5 at max HR", { maxHr: 180, lowBpm: [100, 120, 140, 160, 180] }],
    ["zone 5 above max HR", { maxHr: 170, lowBpm: [100, 120, 140, 160, 180] }],
    ["a fraction", { maxHr: 200, lowBpm: [100, 120.5, 140, 160, 180] }],
    ["four floors", { maxHr: 200, lowBpm: [100, 120, 140, 160] }],
    ["six floors", { maxHr: 200, lowBpm: [100, 120, 140, 160, 180, 190] }],
    ["an unknown field", { ...CUSTOM_ZONES, restingHr: 50 }],
    ["zone 1 under 30 bpm", { maxHr: 200, lowBpm: [20, 120, 140, 160, 180] }],
    ["max HR over 240", { maxHr: 250, lowBpm: [100, 120, 140, 160, 180] }],
    ["no max HR", { lowBpm: [100, 120, 140, 160, 180] }],
    ["floors as text", { maxHr: 200, lowBpm: ["100", "120", "140", "160", "180"] }],
  ])("returns 400 validation and keeps the saved zones for %s", async (_case, body) => {
    const agent = await signedInAgent(app);
    await agent.put(PATH).send(CUSTOM_ZONES);

    const problem = expectProblem(await agent.put(PATH).send(body), 400, "validation");

    expect(problem.issues?.length).toBeGreaterThan(0);
    expect(await storedZones(await ownerId())).toEqual(CUSTOM_ZONES);
  });

  it("changes only the signed-in runner's zones", async () => {
    const other = await signedInAgent(app, OTHER_USER);
    const owner = await signedInAgent(app);

    await owner.put(PATH).send(CUSTOM_ZONES);

    expect(await zonesOf(other)).toEqual({ source: "none", zones: null });
    expect(await storedZones(await ownerId(OTHER_USER.email))).toBeNull();
  });
});

describe("DELETE /api/hr-zones", () => {
  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().delete(PATH), 401, "unauthorized");
  });

  it("goes back to Garmin's zones and clears the saved ones (Reset to Garmin's)", async () => {
    const { agent, userId } = await ownerWithGarminZones();
    await agent.put(PATH).send(CUSTOM_ZONES);

    const response = await agent.delete(PATH);

    expect(response.status).toBe(200);
    expect(hrZonesResponseSchema.parse(response.body)).toEqual({
      source: "garmin",
      zones: GARMIN_ZONES,
    });
    expect(await storedZones(userId)).toBeNull();
    expect(await zonesOf(agent)).toEqual({ source: "garmin", zones: GARMIN_ZONES });
  });

  it("answers the same on a second reset", async () => {
    const { agent } = await ownerWithGarminZones();
    await agent.put(PATH).send(CUSTOM_ZONES);
    const first = await agent.delete(PATH);

    const second = await agent.delete(PATH);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it("leaves another runner's saved zones alone", async () => {
    const other = await signedInAgent(app, OTHER_USER);
    await other.put(PATH).send(CUSTOM_ZONES);
    const owner = await signedInAgent(app);

    await owner.delete(PATH);

    expect(await zonesOf(other)).toEqual({ source: "custom", zones: CUSTOM_ZONES });
  });
});
