import { meResponseSchema } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { userSettings } from "../../src/db/schema";
import { config } from "../../src/lib/config";
import { decrypt } from "../../src/lib/crypto";
import { claudeKeyLimiter } from "../../src/routes/me";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { claudeKey, setSettings } from "../seed";

// Saving the runner's Claude key against the fake Claude, whose GET /v1/models answers as the key's
// fixture says (test/fake-claude.ts).

const app = createTestApp();
const PATH = "/api/me/claude-key";

afterEach(() => {
  claudeKeyLimiter.reset();
});

async function storedKeyEnc(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ claudeKeyEnc: userSettings.claudeKeyEnc })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return row?.claudeKeyEnc ?? null;
}

async function modelChecks(key: string): Promise<unknown[]> {
  const response = await fetch(
    `${config.CLAUDE_BASE_URL}/__requests/${encodeURIComponent(key)}/models`,
  );
  return (await response.json()) as unknown[];
}

describe("PUT /api/me/claude-key", () => {
  it("checks the key with Claude, stores it encrypted and answers with hasClaudeKey and no secret", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const key = claudeKey("valid");

    const response = await agent.put(PATH).send({ key: `  ${key}\n` });

    expect(response.status).toBe(200);
    expect(meResponseSchema.parse(response.body).settings.hasClaudeKey).toBe(true);
    const stored = await storedKeyEnc(userId);
    expect(stored).toMatch(/^v1:/);
    expect(decrypt(stored!, userId)).toBe(key);
    expect(response.text).not.toContain(key);
    expect(response.text).not.toContain(stored!);
    expect(await modelChecks(key)).toHaveLength(1);
  });

  it("replaces a key saved earlier", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await setSettings(userId, { claudeKey: claudeKey("valid") });
    const key = claudeKey("valid");

    expect((await agent.put(PATH).send({ key })).status).toBe(200);

    expect(decrypt((await storedKeyEnc(userId))!, userId)).toBe(key);
  });

  it.each(["key-invalid", "permission-denied"])(
    "returns 422 claude_key_invalid, stores nothing and keeps the older key when Claude rejects it (%s, invalid or expired key)",
    async (fixture) => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      const older = claudeKey("valid");
      await setSettings(userId, { claudeKey: older });
      const key = claudeKey(fixture);

      const response = await agent.put(PATH).send({ key });

      const problem = expectProblem(response, 422, "claude_key_invalid");
      expect(problem.detail).toContain("Claude rejected this key");
      expect(response.text).not.toContain(key);
      expect(decrypt((await storedKeyEnc(userId))!, userId)).toBe(older);
    },
  );

  it("returns 422 and stores nothing for a key Claude does not know", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    const response = await agent.put(PATH).send({ key: "sk-ant-not-a-key" });

    expectProblem(response, 422, "claude_key_invalid");
    expect(await storedKeyEnc(userId)).toBeNull();
  });

  it.each(["unavailable", "rate-limited"])(
    "returns 502 claude_unavailable and stores nothing when Claude answers %s",
    async (fixture) => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      const key = claudeKey(fixture);

      const response = await agent.put(PATH).send({ key });

      expectProblem(response, 502, "claude_unavailable");
      expect(response.text).not.toContain(key);
      expect(await storedKeyEnc(userId)).toBeNull();
      // One try: the runner is waiting and can press Save again.
      expect(await modelChecks(key)).toHaveLength(1);
    },
  );

  it("returns 502 claude_unavailable and stores nothing when the check times out (Claude timeout)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    const response = await agent.put(PATH).send({ key: claudeKey("timeout") });

    expectProblem(response, 502, "claude_unavailable");
    expect(await storedKeyEnc(userId)).toBeNull();
  });

  it("returns 400 validation for a blank or missing key and asks Claude nothing", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    expectProblem(await agent.put(PATH).send({ key: "   " }), 400, "validation");
    expectProblem(await agent.put(PATH).send({}), 400, "validation");
    expectProblem(await agent.put(PATH).send({ key: "x".repeat(513) }), 400, "validation");
    expect(await storedKeyEnc(userId)).toBeNull();
  });

  it("returns 401 without a session", async () => {
    const response = await request(app)
      .put(PATH)
      .send({ key: claudeKey("valid") });

    expectProblem(response, 401, "unauthorized");
  });

  it("returns 429 with Retry-After after six saves in a minute, before asking Claude", async () => {
    const agent = await signedInAgent(app);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await agent.put(PATH).send({ key: claudeKey("valid") })).status).toBe(200);
    }
    const key = claudeKey("valid");

    const response = await agent.put(PATH).send({ key });

    const problem = expectProblem(response, 429, "rate_limited");
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(await modelChecks(key)).toEqual([]);
  });
});

describe("DELETE /api/me/claude-key", () => {
  it("removes the key and answers with hasClaudeKey false", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await setSettings(userId, { claudeKey: claudeKey("valid") });

    const response = await agent.delete(PATH);

    expect(response.status).toBe(200);
    expect(meResponseSchema.parse(response.body).settings.hasClaudeKey).toBe(false);
    expect(await storedKeyEnc(userId)).toBeNull();
  });

  it("answers 200 when there is no key to remove", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.delete(PATH);

    expect(response.status).toBe(200);
    expect(meResponseSchema.parse(response.body).settings.hasClaudeKey).toBe(false);
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).delete(PATH), 401, "unauthorized");
  });
});
