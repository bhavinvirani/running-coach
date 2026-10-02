import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInsight } from "../../src/coach/run-insight";
import { db } from "../../src/db/client";
import { coachMessage, user } from "../../src/db/schema";
import { config } from "../../src/lib/config";
import { createRunInsight } from "../../src/services/insights";
import { claudeKey, claudeRequests, createLongRun, createSettings, createUser } from "../seed";

// The coach end to end against the fake Claude (global-setup.ts): the key names the fixture it replays.

const validFixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../fixtures/claude/valid.json"), "utf8"),
) as { responses: [{ body: { content: [{ json: unknown }] } }] };
const validOutput = validFixture.responses[0].body.content[0].json;

async function insightFor(fixture: string | null, settings: { units?: "km" | "mi" } = {}) {
  const userId = await createUser();
  const key = fixture ? claudeKey(fixture) : undefined;
  await createSettings(userId, { ...settings, ...(key ? { claudeKey: key } : {}) });
  const run = await createLongRun(userId);
  const message = await createRunInsight(userId, run.id);
  return { userId, key, run, message, requests: key ? await claudeRequests(key) : [] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRunInsight", () => {
  it("stores valid output with prompt_version, model and usage", async () => {
    const { message, run, requests } = await insightFor("valid");

    expect(message).toMatchObject({
      kind: "insight",
      activityId: run.id,
      promptVersion: "run-insight/v1",
      model: config.COACH_MODEL,
      content: validOutput,
      usage: { inputTokens: 1180, outputTokens: 164 },
    });
    const [stored] = await db.select().from(coachMessage).where(eq(coachMessage.id, message.id));
    expect(stored?.content).toEqual(validOutput);

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body;
    expect(body).toMatchObject({
      model: config.COACH_MODEL,
      max_tokens: 4096,
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(String(body?.system)).toContain("# Voice");
    expect(String(body?.system)).toContain("# Safety");
  });

  it("sends numbers in the user's units and no key, token or email", async () => {
    const { key, userId, requests } = await insightFor("valid", { units: "mi" });
    const [owner] = await db.select().from(user).where(eq(user.id, userId));

    const sent = JSON.stringify(requests[0]?.body);
    expect(sent).toContain("11.18 mi");
    expect(sent).not.toContain(key);
    expect(sent).not.toContain(owner?.email);
    expect(sent).not.toMatch(/fixture-token|di_token|v1:/);
  });

  it.each([
    ["max-tokens", "max_tokens"],
    ["refusal", "refusal"],
    ["invalid-json", "invalid_output"],
    ["schema-invalid", "invalid_output"],
  ])(
    "stores the fallback card with the billed usage when the model's answer is %s",
    async (fixture) => {
      const { message, requests } = await insightFor(fixture);

      expect(message.model).toBeNull();
      expect(message.usage).toMatchObject({ inputTokens: 1180 });
      expect(message.content).toMatchObject({
        headline: "18.00 km in 1:42:00 at 5:40 /km.",
        caution: "none",
      });
      expect(requests).toHaveLength(1);
    },
  );

  it("gives the fallback after a timeout without retrying", async () => {
    const { message, requests } = await insightFor("timeout");

    expect(message).toMatchObject({ model: null, usage: null });
    expect((message.content as { whatItMeans: string }).whatItMeans).toContain("too long");
    expect(requests).toHaveLength(1);
  });

  it("retries an overloaded call once, on the fallback model", async () => {
    const { message, requests } = await insightFor("overloaded");

    expect(requests.map((request) => request.body.model)).toEqual([
      config.COACH_MODEL,
      config.COACH_FALLBACK_MODEL,
    ]);
    expect(message).toMatchObject({ model: config.COACH_FALLBACK_MODEL, content: validOutput });
  });

  it("gives the fallback when Claude stays down after the retry", async () => {
    const { message, requests } = await insightFor("unavailable");

    expect(requests).toHaveLength(2);
    expect(message).toMatchObject({ model: null, usage: null });
  });

  it("tells the user to update the key when Claude rejects it, without retrying", async () => {
    const { message, requests } = await insightFor("key-invalid");

    expect(requests).toHaveLength(1);
    expect((message.content as { whatItMeans: string }).whatItMeans).toContain(
      "Update it in Settings",
    );
  });

  it("stores the fallback card without calling Claude when there is no key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { message } = await insightFor(null);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(message).toMatchObject({ model: null, usage: null, promptVersion: "run-insight/v1" });
    expect((message.content as { whatItMeans: string }).whatItMeans).toContain(
      "add your Claude API key",
    );
  });

  it("refuses a run that belongs to another user", async () => {
    const ownerId = await createUser();
    const otherId = await createUser("other@example.com");
    const run = await createLongRun(otherId);

    await expect(createRunInsight(ownerId, run.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await db.select().from(coachMessage)).toHaveLength(0);
  });
});

describe("runInsight", () => {
  it("makes no call and returns the missing_key fallback when the key is null", async () => {
    const result = await runInsight({
      apiKey: null,
      activity: await createLongRun(await createUser()),
      settings: { units: "km", coachDetail: "short" },
    });

    expect(result).toMatchObject({
      fallback: true,
      fallbackReason: "missing_key",
      model: null,
      usage: null,
    });
  });
});
