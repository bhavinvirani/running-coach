import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachCallCredential } from "../../src/coach/client";
import { buildWeeklyReviewInput } from "../../src/coach/prompts/weekly-review/input";
import type {
  ReviewPlan,
  ReviewSettings,
  ReviewWeek,
} from "../../src/coach/prompts/weekly-review/input";
import { weeklyReview } from "../../src/coach/weekly-review";
import { config } from "../../src/lib/config";
import { claudeKey, claudeRequests } from "../seed";

// The weekly review's call end to end against the fake Claude (global-setup.ts): the key names the fixture
// it replays. weeklyReview never touches the database; storing the card, the engine's checks of the changes
// and the job's retries belong to the service and the job. The plan path waits for #48's fakes.

const FIXTURES = path.join(import.meta.dirname, "../fixtures/claude");

/** The model's JSON in a fixture's last response. */
function fixtureOutput(fixture: string): Record<string, unknown> {
  const { responses } = JSON.parse(
    readFileSync(path.join(FIXTURES, `${fixture}.json`), "utf8"),
  ) as {
    responses: { body: { content: { json: Record<string, unknown> }[] } }[];
  };
  return responses.at(-1)!.body.content[0]!.json;
}

/**
 * Three of four sessions done, Friday's easy run missed, an indoor run without heart rate beside the plan,
 * and a coming week whose tempo the runner moved to Thursday.
 */
const week: ReviewWeek = {
  weekStart: "2026-09-28",
  sessions: [
    {
      date: "2026-09-29",
      type: "easy",
      title: null,
      status: "done",
      distanceM: 8000,
      durationS: 2700,
      run: { distanceM: 8100, durationS: 2730, avgHr: 141, isIndoor: false },
    },
    {
      date: "2026-10-01",
      type: "tempo",
      title: null,
      status: "done",
      distanceM: 9000,
      durationS: 2880,
      run: { distanceM: 9050, durationS: 2850, avgHr: 162, isIndoor: false },
    },
    {
      date: "2026-10-02",
      type: "easy",
      title: null,
      status: "missed",
      distanceM: 6000,
      durationS: 2040,
      run: null,
    },
    {
      date: "2026-10-04",
      type: "long",
      title: null,
      status: "done",
      distanceM: 16_000,
      durationS: 5760,
      run: { distanceM: 16_200, durationS: 5900, avgHr: 149, isIndoor: false },
    },
  ],
  extraRuns: [
    { date: "2026-10-03", distanceM: 5000, durationS: 1800, avgHr: null, isIndoor: true },
  ],
  summary: {
    runs: 4,
    distanceM: 38_350,
    durationS: 13_280,
    sessionsPlanned: 4,
    sessionsDone: 3,
    plannedDistanceM: 39_000,
    paused: false,
  },
  weekBefore: { runs: 4, distanceM: 36_000 },
  pause: null,
};

const plan: ReviewPlan = {
  goal: { kind: "race", distanceKey: "half", raceDate: "2026-12-13", targetTimeS: 6600 },
  weekNumber: 7,
  phase: "build",
  weeksToRace: 9,
  sessions: [
    {
      label: "s1",
      date: "2026-10-06",
      type: "easy",
      title: null,
      status: "planned",
      distanceM: 8000,
      durationS: 2700,
      changeable: true,
    },
    {
      label: "s2",
      date: "2026-10-08",
      type: "tempo",
      title: null,
      status: "moved",
      distanceM: 9000,
      durationS: 2880,
      changeable: true,
    },
    {
      label: "s3",
      date: "2026-10-09",
      type: "easy",
      title: null,
      status: "planned",
      distanceM: 6000,
      durationS: 2040,
      changeable: true,
    },
    {
      label: "s4",
      date: "2026-10-11",
      type: "long",
      title: null,
      status: "planned",
      distanceM: 17_000,
      durationS: 6120,
      changeable: true,
    },
  ],
  changeAllowed: true,
  reason: null,
};

const km: ReviewSettings = { units: "km", coachDetail: "standard" };

function onKey(fixture: string): { credential: CoachCallCredential; key: string } {
  const key = claudeKey(fixture);
  return { credential: { kind: "key", apiKey: key }, key };
}

async function review(
  fixture: string,
  input: { week?: ReviewWeek; plan?: ReviewPlan | null; settings?: ReviewSettings } = {},
) {
  const { credential, key } = onKey(fixture);
  const result = await weeklyReview({
    credential,
    week: input.week ?? week,
    plan: input.plan === undefined ? plan : input.plan,
    settings: input.settings ?? km,
  });
  return { result, key, requests: await claudeRequests(key) };
}

/** The user message the fake Claude received in the key's first request. */
async function sentMessage(key: string): Promise<string> {
  const [request] = await claudeRequests(key);
  const messages = request?.body.messages as { content: string }[] | undefined;
  return messages?.[0]?.content ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("weeklyReview", () => {
  it("returns the coach's review as Claude wrote it, with no changes, its model, usage and prompt version", async () => {
    const { result, requests } = await review("weekly-review-valid");

    const { changes, ...card } = fixtureOutput("weekly-review-valid");
    expect(changes).toEqual([]);
    expect(result).toEqual({
      limited: false,
      content: card,
      changes: [],
      fallback: false,
      fallbackReason: null,
      usage: { inputTokens: 1420, outputTokens: 188 },
      model: config.COACH_MODEL,
      promptVersion: "weekly-review/v1",
      requestId: "req_fake_1",
    });
    expect(requests).toHaveLength(1);
    const body = requests[0]?.body;
    expect(body).toMatchObject({
      model: config.COACH_MODEL,
      max_tokens: 4096,
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(String(body?.system)).toContain("# Voice");
    expect(String(body?.system)).toContain("# Safety");
    expect(String(body?.system)).toContain("# Changes to the coming week");
  });

  it("returns the changes Claude proposes by label as written, a rise of 1.3 included, for the engine to clamp", async () => {
    const { result } = await review("weekly-review-changes");

    expect(result).toMatchObject({ limited: false, fallback: false, fallbackReason: null });
    expect(result.limited === false && result.changes).toEqual([
      expect.objectContaining({ session: "s1", kind: "scale", factor: 1.3 }),
      expect.objectContaining({ session: "s2", kind: "easy", factor: null }),
      expect.objectContaining({ session: "s3", kind: "rest", factor: null }),
    ]);
    expect(result.limited === false && result.content).not.toHaveProperty("changes");
  });

  it("sends the week as the input builds it: missed and moved sessions as stored, missing HR as missing, the indoor run flagged (missed and moved sessions, missing HR, indoor run)", async () => {
    const { key } = await review("weekly-review-valid");

    const message = await sentMessage(key);
    expect(message).toBe(buildWeeklyReviewInput(week, plan, km));
    expect(message).toContain(
      "- Friday 2 October 2026: Easy (easy), 6.0 km, 34:00. Status: missed. Run: none.",
    );
    expect(message).toContain("Status: moved to this day by the runner. May change.");
    expect(message).toContain(
      "- Saturday 3 October 2026: 5.0 km in 30:00 at 6:00 /km, heart rate missing, indoor run (treadmill)",
    );
  });

  it("sends numbers in the runner's units and no key, token or email (unit conversion)", async () => {
    const { key, requests } = await review("weekly-review-valid", {
      settings: { units: "mi", coachDetail: "detailed" },
    });

    const message = await sentMessage(key);
    expect(message).toContain("Units: miles");
    expect(message).toContain("Runs: 4, 23.8 mi in 3:41:20");
    expect(message).toContain("- s4, Sunday 11 October 2026: Long run (long), 10.6 mi, 1:42:00.");
    expect(message).not.toMatch(/\d km|\/km/);
    const sent = JSON.stringify(requests[0]?.body);
    expect(sent).not.toContain(key);
    expect(sent).not.toMatch(/@|fixture-token|di_token|v1:/);
  });

  it("sends a week paused as sick as paused, with changes not allowed while the pause is open (paused week)", async () => {
    const { key, result } = await review("weekly-review-valid", {
      week: {
        ...week,
        summary: { ...week.summary, paused: true },
        pause: { reason: "sick", startDate: "2026-10-02", endDate: null },
      },
      plan: { ...plan, changeAllowed: false, reason: "paused" },
    });

    const message = await sentMessage(key);
    expect(message).toContain("Training pause: sick, since Friday 2 October 2026, still open");
    expect(message.split("\n").at(-1)).toBe(
      "Changes to the coming week: not allowed (training is paused)",
    );
    expect(result).toMatchObject({ fallback: false });
  });

  it("returns the timeout card after one call, without retrying (Claude quota or timeout)", async () => {
    const { result, requests } = await review("timeout");

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      limited: false,
      fallback: true,
      fallbackReason: "timeout",
      changes: [],
      model: null,
      usage: null,
      promptVersion: "weekly-review/v1",
    });
    expect(result.limited === false && result.content.whatItMeans).toContain(
      "Claude took too long to answer.",
    );
  });

  it("retries an overloaded call once, on the fallback model", async () => {
    const { result, requests } = await review("weekly-review-overloaded");

    expect(requests.map((request) => request.body.model)).toEqual([
      config.COACH_MODEL,
      config.COACH_FALLBACK_MODEL,
    ]);
    const { changes: _changes, ...card } = fixtureOutput("weekly-review-overloaded");
    expect(result).toMatchObject({
      fallback: false,
      model: config.COACH_FALLBACK_MODEL,
      content: card,
      changes: [],
    });
  });

  it.each([
    ["unavailable", "unavailable", 2],
    ["rate-limited", "unavailable", 2],
    ["request-rejected", "request_rejected", 1],
  ] as const)(
    "returns the %s card with its reason, retrying only a transient failure (Claude quota or timeout)",
    async (fixture, reason, calls) => {
      const { result, requests } = await review(fixture);

      expect(requests).toHaveLength(calls);
      expect(result).toMatchObject({
        fallback: true,
        fallbackReason: reason,
        changes: [],
        model: null,
        usage: null,
      });
    },
  );

  it("returns the replace-key card after one call when Claude rejects the key (invalid key)", async () => {
    const { result, requests } = await review("key-invalid");

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ fallback: true, fallbackReason: "key_invalid", changes: [] });
    expect(result.limited === false && result.content.whatItMeans).toContain(
      "Replace it in Settings.",
    );
  });

  it("makes no call and returns the missing_key card without a credential", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await weeklyReview({ credential: null, week, plan, settings: km });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      limited: false,
      fallback: true,
      fallbackReason: "missing_key",
      changes: [],
      model: null,
      usage: null,
      requestId: null,
      promptVersion: "weekly-review/v1",
    });
    expect(result.limited === false && result.content.headline).toBe(
      "3 of 4 sessions done, 38.4 km run.",
    );
  });

  it.each([
    "weekly-review-too-many-changes",
    "weekly-review-change-no-note",
    "schema-invalid",
    "invalid-json",
  ])(
    "returns the fallback card with the billed usage and no change when the output is %s (invalid output)",
    async (fixture) => {
      const { result, requests } = await review(fixture);

      expect(requests).toHaveLength(1);
      expect(result).toMatchObject({
        fallback: true,
        fallbackReason: "invalid_output",
        changes: [],
        model: null,
        usage: { inputTokens: expect.any(Number) as number },
      });
      expect(result.limited === false && result.content.headline).toBe(
        "3 of 4 sessions done, 38.4 km run.",
      );
    },
  );

  it.each([
    ["max-tokens", "max_tokens"],
    ["refusal", "refusal"],
  ] as const)(
    "returns the fallback card with the billed usage when the answer is %s",
    async (fixture, reason) => {
      const { result, requests } = await review(fixture);

      expect(requests).toHaveLength(1);
      expect(result).toMatchObject({
        fallback: true,
        fallbackReason: reason,
        changes: [],
        model: null,
        usage: { inputTokens: 1180 },
      });
    },
  );
});
