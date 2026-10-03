import { meResponseSchema, type UpdateSettingsRequest } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { garminConnection, userSettings } from "../../src/db/schema";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { encrypt } from "../../src/lib/crypto";
import { configureCoachService, FAKE_COACH_SECRET } from "../fake-coach-service";
import { createTestApp, expectProblem, ownerId, signedInAgent, TEST_OWNER } from "../helpers";
import { claudeKey, connectGarmin, setSettings } from "../seed";

// pg-boss runs without workers, so a queued workout push stays queued. The coach service is only
// configured here, never called: settings read whether it is set up, not whether it answers.

const app = createTestApp();

/** A coach service URL nothing is asked of in these tests. */
const COACH_SERVICE = { url: "http://127.0.0.1:9", secret: FAKE_COACH_SECRET };
const OTHER_USER = {
  email: "other@example.com",
  password: "another-horse-battery-staple",
  name: "Other Runner",
} as const;

let restoreConfig: (() => void) | undefined;

/** The coach service set up with the test owner as OWNER_EMAIL, with these values changed. */
function coachServiceSetUp(overrides: Parameters<typeof configureCoachService>[1] = {}): void {
  restoreConfig?.();
  restoreConfig = configureCoachService(COACH_SERVICE, overrides);
}

afterEach(() => {
  restoreConfig?.();
  restoreConfig = undefined;
});

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

describe("GET /api/me", () => {
  it("returns the user with the default settings created with the account", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.get("/api/me");

    expect(response.status).toBe(200);
    const me = meResponseSchema.parse(response.body);
    expect(me.user).toMatchObject({ email: TEST_OWNER.email, name: TEST_OWNER.name });
    expect(me.settings).toEqual({
      units: "km",
      timezone: "UTC",
      coachDetail: "standard",
      hasClaudeKey: false,
      coachCredential: "none",
      claudePlanAvailable: false,
    });
    expect(me.garmin).toEqual({ status: "not_connected", lastSyncAt: null });
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, me.user.id));
    expect(rows).toHaveLength(1);
  });

  it("tells the browser not to store the response, signed in or not", async () => {
    const agent = await signedInAgent(app);

    const signedIn = await agent.get("/api/me");
    const signedOut = await request(app).get("/api/me");
    const unknown = await agent.get("/api/nothing-here");

    expect(signedIn.headers["cache-control"]).toBe("no-store");
    expect(signedOut.headers["cache-control"]).toBe("no-store");
    expect(unknown.headers["cache-control"]).toBe("no-store");
  });

  it("reports the Garmin connection and whether a Claude key exists, never a secret", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const claudeKeyEnc = encrypt("sk-ant-fake-test-key", userId);
    const tokenBundleEnc = encrypt('{"di_token":"fixture-token"}', userId);
    await db.update(userSettings).set({ claudeKeyEnc }).where(eq(userSettings.userId, userId));
    await db.insert(garminConnection).values({
      userId,
      tokenBundleEnc,
      status: "expired",
      lastSyncAt: new Date("2026-09-27T06:30:00Z"),
    });

    const response = await agent.get("/api/me");

    const me = meResponseSchema.parse(response.body);
    expect(me.settings.hasClaudeKey).toBe(true);
    expect(me.garmin).toEqual({ status: "expired", lastSyncAt: "2026-09-27T06:30:00.000Z" });
    for (const secret of ["sk-ant", "fixture-token", claudeKeyEnc, tokenBundleEnc, "v1:"]) {
      expect(response.text).not.toContain(secret);
    }
  });

  it.each([
    [
      "neither coach service variable is set",
      { COACH_SERVICE_URL: undefined, COACH_SERVICE_SECRET: undefined },
      false,
    ],
    ["only COACH_SERVICE_URL is set", { COACH_SERVICE_SECRET: undefined }, false],
    ["only COACH_SERVICE_SECRET is set", { COACH_SERVICE_URL: undefined }, false],
    ["both coach service variables are set", {}, true],
  ] as const)(
    "offers the owner the Claude plan only when both are set: %s",
    async (_case, overrides, offered) => {
      coachServiceSetUp(overrides);
      const agent = await signedInAgent(app);

      const me = meResponseSchema.parse((await agent.get("/api/me")).body);

      expect(me.settings.claudePlanAvailable).toBe(offered);
    },
  );

  it("offers the Claude plan only to OWNER_EMAIL, compared without regard to case", async () => {
    coachServiceSetUp({ OWNER_EMAIL: "Runner@Example.COM" });
    const owner = await signedInAgent(app);
    const other = await signedInAgent(app, OTHER_USER);

    const ownerMe = meResponseSchema.parse((await owner.get("/api/me")).body);
    const otherMe = meResponseSchema.parse((await other.get("/api/me")).body);

    expect(ownerMe.settings.claudePlanAvailable).toBe(true);
    expect(otherMe.settings.claudePlanAvailable).toBe(false);
  });

  it("reports the credential the coach uses: the plan when chosen and offered, else a saved key, else none", async () => {
    coachServiceSetUp();
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const credential = async () =>
      meResponseSchema.parse((await agent.get("/api/me")).body).settings.coachCredential;

    expect(await credential()).toBe("none");
    await setSettings(userId, { claudeKey: claudeKey("valid") });
    expect(await credential()).toBe("key");
    await setSettings(userId, { coachCredential: "plan" });
    expect(await credential()).toBe("plan");
  });

  it.each([
    ["a saved key", true, "key"],
    ["no key", false, "none"],
  ] as const)(
    "resolves a stored plan choice to %s once the coach service variables are removed (env removed)",
    async (_case, withKey, expected) => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      await setSettings(userId, {
        coachCredential: "plan",
        ...(withKey ? { claudeKey: claudeKey("valid") } : {}),
      });
      coachServiceSetUp({ COACH_SERVICE_URL: undefined, COACH_SERVICE_SECRET: undefined });

      const me = meResponseSchema.parse((await agent.get("/api/me")).body);

      expect(me.settings).toMatchObject({ coachCredential: expected, claudePlanAvailable: false });
      const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
      expect(row?.coachCredential).toBe("plan");
    },
  );

  it("resolves a stored plan choice to the key for a user who is not the owner", async () => {
    coachServiceSetUp();
    const agent = await signedInAgent(app, OTHER_USER);
    await setSettings(await ownerId(OTHER_USER.email), {
      coachCredential: "plan",
      claudeKey: claudeKey("valid"),
    });

    const me = meResponseSchema.parse((await agent.get("/api/me")).body);

    expect(me.settings).toMatchObject({ coachCredential: "key", claudePlanAvailable: false });
  });

  it("never returns the coach service's URL or secret", async () => {
    coachServiceSetUp();
    const agent = await signedInAgent(app);

    const response = await agent.get("/api/me");

    expect(response.text).not.toContain(FAKE_COACH_SECRET);
    expect(response.text).not.toContain(COACH_SERVICE.url);
  });

  it("returns 401 problem+json without a session", async () => {
    const response = await request(app).get("/api/me");

    const problem = expectProblem(response, 401, "unauthorized");
    expect(problem).not.toHaveProperty("stack");
  });

  it("returns 401 with a forged session cookie", async () => {
    const response = await request(app)
      .get("/api/me")
      .set("cookie", "better-auth.session_token=forged.value");

    expectProblem(response, 401, "unauthorized");
  });
});

describe("PATCH /api/me/settings", () => {
  it("persists the change and returns the new state", async () => {
    const agent = await signedInAgent(app);

    const response = await agent
      .patch("/api/me/settings")
      .send({ units: "mi", timezone: "Europe/London", coachDetail: "detailed" });

    expect(response.status).toBe(200);
    const me = meResponseSchema.parse(response.body);
    expect(me.settings).toEqual({
      units: "mi",
      timezone: "Europe/London",
      coachDetail: "detailed",
      hasClaudeKey: false,
      coachCredential: "none",
      claudePlanAvailable: false,
    });
    const reread = meResponseSchema.parse((await agent.get("/api/me")).body);
    expect(reread.settings).toEqual(me.settings);
  });

  it("changes only the fields it is given", async () => {
    const agent = await signedInAgent(app);
    await agent.patch("/api/me/settings").send({ units: "mi" });

    const response = await agent.patch("/api/me/settings").send({ timezone: "America/New_York" });

    expect(meResponseSchema.parse(response.body).settings).toMatchObject({
      units: "mi",
      timezone: "America/New_York",
      coachDetail: "standard",
    });
  });

  it("returns 400 validation with issues for bad units and stores nothing", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.patch("/api/me/settings").send({ units: "furlongs" });

    const problem = expectProblem(response, 400, "validation");
    expect(problem.issues).toEqual([expect.objectContaining({ path: "units" })]);
    const me = meResponseSchema.parse((await agent.get("/api/me")).body);
    expect(me.settings.units).toBe("km");
  });

  it("returns 400 validation for an unknown time zone", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.patch("/api/me/settings").send({ timezone: "Mars/Olympus_Mons" });

    expectProblem(response, 400, "validation");
  });

  it("returns 400 validation for unknown fields, so a client cannot write the Claude key here", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.patch("/api/me/settings").send({ claudeKeyEnc: "v1:abc" });

    expectProblem(response, 400, "validation");
    const [row] = await db.select().from(userSettings);
    expect(row?.claudeKeyEnc ?? null).toBeNull();
  });

  it("returns 400 validation for an empty patch and for a body that is not JSON", async () => {
    const agent = await signedInAgent(app);

    const empty = await agent.patch("/api/me/settings").send({});
    const broken = await agent
      .patch("/api/me/settings")
      .set("content-type", "application/json")
      .send("{not json");

    expectProblem(empty, 400, "validation");
    expectProblem(broken, 400, "validation");
  });

  it.each<[string, UpdateSettingsRequest]>([
    ["units (unit conversion)", { units: "mi" }],
    ["time zone (time zones)", { timezone: "Europe/Berlin" }],
  ])(
    "queues a workout push when the %s changes, since every workout's name or the window moves",
    async (_, patch) => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      await connectGarmin(userId);

      expect((await agent.patch("/api/me/settings").send(patch)).status).toBe(200);

      expect(await pushJobs(userId)).toHaveLength(1);
    },
  );

  it("queues no workout push for an unchanged value, a coach-detail change or a login that does not work", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);

    for (const patch of [{ units: "km" }, { timezone: "UTC" }, { coachDetail: "detailed" }]) {
      expect((await agent.patch("/api/me/settings").send(patch)).status).toBe(200);
    }
    expect(await pushJobs(userId)).toEqual([]);

    await db
      .update(garminConnection)
      .set({ status: "expired" })
      .where(eq(garminConnection.userId, userId));
    expect((await agent.patch("/api/me/settings").send({ units: "mi" })).status).toBe(200);
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("switches the owner to the Claude plan when it is offered, and back to the key", async () => {
    coachServiceSetUp();
    const agent = await signedInAgent(app);
    await setSettings(await ownerId(), { claudeKey: claudeKey("valid") });

    const toPlan = await agent.patch("/api/me/settings").send({ coachCredential: "plan" });
    const toKey = await agent.patch("/api/me/settings").send({ coachCredential: "key" });

    expect(toPlan.status).toBe(200);
    expect(meResponseSchema.parse(toPlan.body).settings).toMatchObject({
      coachCredential: "plan",
      claudePlanAvailable: true,
    });
    expect(meResponseSchema.parse(toKey.body).settings.coachCredential).toBe("key");
  });

  it("returns 409 claude_plan_unavailable and changes nothing when a user who is not the owner chooses the plan", async () => {
    coachServiceSetUp();
    const agent = await signedInAgent(app, OTHER_USER);

    const response = await agent
      .patch("/api/me/settings")
      .send({ coachCredential: "plan", units: "mi" });

    const problem = expectProblem(response, 409, "claude_plan_unavailable");
    expect(problem.detail).toBe("The Claude plan is not set up for this account.");
    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, await ownerId(OTHER_USER.email)));
    expect(row).toMatchObject({ coachCredential: "key", units: "km" });
  });

  it.each([
    ["not set up", { COACH_SERVICE_URL: undefined, COACH_SERVICE_SECRET: undefined }],
    ["missing its secret", { COACH_SERVICE_SECRET: undefined }],
  ] as const)(
    "returns 409 claude_plan_unavailable to the owner when the coach service is %s",
    async (_case, overrides) => {
      coachServiceSetUp(overrides);
      const agent = await signedInAgent(app);

      const response = await agent.patch("/api/me/settings").send({ coachCredential: "plan" });

      expectProblem(response, 409, "claude_plan_unavailable");
      const [row] = await db.select().from(userSettings);
      expect(row?.coachCredential).toBe("key");
    },
  );

  it("lets a user who is not the owner choose the key: the key is always allowed", async () => {
    const agent = await signedInAgent(app, OTHER_USER);

    const response = await agent.patch("/api/me/settings").send({ coachCredential: "key" });

    expect(response.status).toBe(200);
    expect(meResponseSchema.parse(response.body).settings.coachCredential).toBe("none");
  });

  it("returns 400 validation for a coach credential outside key and plan", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.patch("/api/me/settings").send({ coachCredential: "none" });

    expectProblem(response, 400, "validation");
  });

  it("returns 401 without a session and changes nothing", async () => {
    const response = await request(app).patch("/api/me/settings").send({ units: "mi" });

    expectProblem(response, 401, "unauthorized");
    expect(await db.select().from(userSettings)).toHaveLength(0);
  });
});
