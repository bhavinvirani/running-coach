import {
  ErrorCode,
  insightResponseSchema,
  latestActivityResponseSchema,
  meResponseSchema,
  type InsightResponse,
  type MeResponse,
  type Problem,
} from "@running-coach/shared";
import type { Locator, Page, Response } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import {
  fakeClaudeCalls,
  fakeClaudeCodeRuns,
  fakeClaudeKey,
  fixtureRunIds,
  longRunFallbackInsight,
  seedClaudeKey,
  seedInsight,
  seedLongRun,
  seedRunDetail,
  storedClaudeKey,
} from "./fixtures/seed";
import { expect, test } from "./fixtures/login";

// The coach against the fakes playwright.config.ts starts: on a key, the fake Claude, where a key
// "test-<fixture>.<nonce>" picks the fixture it answers with (apps/api/test/fixtures/claude); on the owner's
// Claude plan, the coach service over the fake Claude Code CLI, which answers every run with one card. The
// runner is the owner and the coach service is set up, so Settings always offers the plan, and every test
// starts on a key. No test connects Garmin, so no app-open sync runs.

/**
 * The card the fake Claude's "valid" fixture writes (apps/api/test/fixtures/claude/valid.json), as the
 * run screen shows it.
 */
const validCard = {
  headline: "18.0 km long run at 5:40 /km.",
  whatHappened:
    "18.0 km in 1:42:00 at 5:40 /km, average heart rate 148 bpm, max 166 bpm, 142 m of climbing.",
  whatItMeans: "148 bpm at 5:40 /km over 1:42:00 is an aerobic effort; the long run did its job.",
  nextStep: "Make the next run easy, around 30 to 40 minutes, then follow the plan.",
  caution: "Make the next run easy",
} as const;

/**
 * The card the fake Claude Code CLI writes on the plan (CARD in apps/coach/test/fake-claude-code.mjs), as
 * the run screen shows it. Its caution is none, so no caution line.
 */
const planCard = {
  headline: "Easy 8.0 km at 5:30 per km, heart rate 146 bpm",
  whatHappened:
    "You ran 8.0 km in 44:00 at an even 5:30 per km. Average heart rate 146 bpm, in your easy zone.",
  whatItMeans:
    "Pace and heart rate matched the easy run planned for today. Aerobic work with no extra fatigue.",
  nextStep: "Rest tomorrow. Thursday's 6 x 800 m intervals stay as planned.",
} as const;

/** What the Claude card says in place of the key form while the plan is chosen. */
const planLine =
  "The coach runs on your Claude plan, through the coach service. Each review counts toward your plan's usage limits.";

/**
 * The analyze-run worker polls every 2 s and the screen reads the card every 3 s while it waits; on the
 * plan the coach service's run of the fake CLI takes about a second more.
 */
const CARD_TIMEOUT_MS = 15_000;

function region(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title, exact: true });
}

async function getSettings(page: Page): Promise<MeResponse["settings"]> {
  const me = meResponseSchema.parse(await (await page.request.get("/api/me")).json());
  return me.settings;
}

async function hasClaudeKey(page: Page): Promise<boolean> {
  return (await getSettings(page)).hasClaudeKey;
}

const isSaveSettings = (response: Response) =>
  response.request().method() === "PATCH" && response.url().endsWith("/api/me/settings");

/**
 * Taps a choice under "Coach uses" in the Claude card and returns the save's answer. The radio itself is
 * visually hidden; a thumb taps its label.
 */
async function chooseCredential(page: Page, label: "Claude plan" | "API key"): Promise<Response> {
  const saved = page.waitForResponse(isSaveSettings);
  await region(page, "Claude")
    .getByRole("group", { name: "Coach uses" })
    .getByText(label, { exact: true })
    .click();
  return saved;
}

/** A seeded run with its laps and route, so the screen never asks Garmin, which no test connects. */
async function seedRun(): Promise<void> {
  await seedLongRun();
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");
}

/** Opens the one seeded run by its address: the screen under test is the run, not the way there. */
async function openSeededRun(page: Page): Promise<string> {
  const latest = latestActivityResponseSchema.parse(
    await (await page.request.get("/api/activities/latest")).json(),
  );
  if (!latest.activity) throw new Error("No run was seeded");
  await page.goto(`/runs/${latest.activity.id}`);
  await expect(page.getByRole("heading", { name: "Sun 27 Sep", level: 1 })).toBeVisible();
  return latest.activity.id;
}

async function getInsight(page: Page, runId: string): Promise<InsightResponse> {
  const response = await page.request.get(`/api/activities/${runId}/insight`);
  expect(response.ok()).toBe(true);
  return insightResponseSchema.parse(await response.json());
}

const isSaveKey = (response: Response) =>
  response.request().method() === "PUT" && response.url().endsWith("/api/me/claude-key");

/** The coach's card from the "valid" fixture: headline, the three parts in order, the caution, thumbs. */
async function expectValidCard(coach: Locator): Promise<void> {
  await expect(coach.getByText(validCard.headline, { exact: true })).toBeVisible({
    timeout: CARD_TIMEOUT_MS,
  });
  await expect(coach.getByRole("heading", { level: 3 })).toHaveText([
    "What happened",
    "What it means",
    "Next",
  ]);
  await expect(coach.getByText(validCard.whatHappened, { exact: true })).toBeVisible();
  await expect(coach.getByText(validCard.whatItMeans, { exact: true })).toBeVisible();
  await expect(coach.getByText(validCard.nextStep, { exact: true })).toBeVisible();
  await expect(coach.getByText(validCard.caution, { exact: true })).toBeVisible();
  await expect(coach.getByRole("button", { name: "Helpful", exact: true })).toBeVisible();
  await expect(coach.getByRole("button", { name: "Not helpful", exact: true })).toBeVisible();
}

test("saves a key Claude accepts, keeps it after a reload, and removes it", async ({ page }) => {
  const key = fakeClaudeKey("valid");
  await page.goto("/settings");
  const section = region(page, "Claude");
  const field = section.getByLabel("Claude API key");

  await field.fill(key);
  const saved = page.waitForResponse(isSaveKey);
  await section.getByRole("button", { name: "Save key" }).click();
  expect((await saved).ok()).toBe(true);

  await expect(section.getByText("Saved", { exact: true })).toBeVisible();
  await expect(field).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Replace key" })).toBeVisible();
  expect(await hasClaudeKey(page)).toBe(true);
  // Checked with Claude once before it was stored, and stored encrypted, never as typed.
  expect(await fakeClaudeCalls(page.request, key, "models")).toHaveLength(1);
  const stored = await storedClaudeKey();
  expect(stored).toMatch(/^v1:/);
  expect(stored).not.toContain(key);

  await page.reload();
  await expect(section.getByText("Saved", { exact: true })).toBeVisible();

  await section.getByRole("button", { name: "Remove key" }).click();
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(section.getByText("Saved", { exact: true })).toHaveCount(0);
  expect(await hasClaudeKey(page)).toBe(false);
  expect(await storedClaudeKey()).toBeNull();
});

test("a key Claude rejects says what to do, stays in the field to fix, and is not stored", async ({
  page,
}) => {
  const rejected = fakeClaudeKey("key-invalid");
  await page.goto("/settings");
  const section = region(page, "Claude");
  const field = section.getByLabel("Claude API key");

  await field.fill(rejected);
  const refused = page.waitForResponse(isSaveKey);
  await section.getByRole("button", { name: "Save key" }).click();
  expect((await refused).status()).toBe(422);

  await expect(section.getByRole("alert")).toHaveText(errorMessages.claude_key_invalid);
  await expect(field).toHaveValue(rejected);
  await expect(section.getByRole("button", { name: "Save key" })).toBeEnabled();
  await expect(section.getByText("Saved", { exact: true })).toHaveCount(0);
  expect(await fakeClaudeCalls(page.request, rejected, "models")).toHaveLength(1);
  expect(await hasClaudeKey(page)).toBe(false);
  expect(await storedClaudeKey()).toBeNull();

  // The runner copies the key again over the rejected one.
  const accepted = fakeClaudeKey("valid");
  await field.fill(accepted);
  await section.getByRole("button", { name: "Save key" }).click();
  await expect(section.getByText("Saved", { exact: true })).toBeVisible();
  await expect(section.getByRole("alert")).toHaveCount(0);
  expect(await hasClaudeKey(page)).toBe(true);
});

test("Ask the coach writes the run's review, and a thumbs up stays after a reload", async ({
  page,
}) => {
  await seedRun();
  const key = await seedClaudeKey("valid");
  const runId = await openSeededRun(page);
  const coach = region(page, "Coach");

  await expect(coach.getByText("No coach review for this run yet.", { exact: true })).toBeVisible();
  const asked = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(`/${runId}/insight`),
  );
  await coach.getByRole("button", { name: "Ask the coach" }).click();
  expect((await asked).ok()).toBe(true);
  // The ask answers pending, and the screen shows it until its next read finds the card, 3 s later.
  await expect(coach.getByRole("status")).toContainText("The coach is reviewing this run.");

  await expectValidCard(coach);
  await expect(coach.getByRole("status")).toHaveCount(0);
  await expect(coach.getByRole("button", { name: "Ask the coach" })).toHaveCount(0);
  // One Claude call for one ask, on the runner's own key.
  expect(await fakeClaudeCalls(page.request, key, "messages")).toHaveLength(1);
  const written = await getInsight(page, runId);
  expect(written).toMatchObject({
    state: "ready",
    insight: { fallbackReason: null, feedback: null, content: { headline: validCard.headline } },
  });

  const helpful = coach.getByRole("button", { name: "Helpful", exact: true });
  const notHelpful = coach.getByRole("button", { name: "Not helpful", exact: true });
  await expect(helpful).toHaveAttribute("aria-pressed", "false");
  const rated = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith("/feedback"),
  );
  await helpful.click();
  expect((await rated).ok()).toBe(true);
  await expect(helpful).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(coach.getByText(validCard.headline, { exact: true })).toBeVisible();
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  await expect(notHelpful).toHaveAttribute("aria-pressed", "false");
  expect(await getInsight(page, runId)).toMatchObject({
    state: "ready",
    insight: { feedback: "up" },
  });
  // Opened again, the run shows the stored card: no second call.
  expect(await fakeClaudeCalls(page.request, key, "messages")).toHaveLength(1);
});

test("Try again on a fallback card asks the coach again, and its card replaces the fallback", async ({
  page,
}) => {
  await seedRun();
  const key = await seedClaudeKey("valid");
  // Claude was down on every try when the run came in: the job stored the fallback card.
  await seedInsight(fixtureRunIds.longRun, longRunFallbackInsight, {
    fallbackReason: "unavailable",
  });
  const runId = await openSeededRun(page);
  const coach = region(page, "Coach");

  await expect(coach.getByText(longRunFallbackInsight.whatItMeans, { exact: true })).toBeVisible();
  // Not the coach's work, so nothing to rate.
  await expect(coach.getByRole("button", { name: "Helpful", exact: true })).toHaveCount(0);

  await coach.getByRole("button", { name: "Try again" }).click();
  await expect(coach.getByRole("status")).toContainText("The coach is reviewing this run.");

  await expectValidCard(coach);
  await expect(coach.getByText(longRunFallbackInsight.whatItMeans, { exact: true })).toHaveCount(0);
  await expect(coach.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(await fakeClaudeCalls(page.request, key, "messages")).toHaveLength(1);
  expect(await getInsight(page, runId)).toMatchObject({
    state: "ready",
    insight: { fallbackReason: null },
  });
});

test("a fallback card for a rejected key offers Replace key, which opens Settings, beside Try again", async ({
  page,
}) => {
  await seedRun();
  await seedClaudeKey("key-invalid");
  await seedInsight(
    fixtureRunIds.longRun,
    {
      ...longRunFallbackInsight,
      whatItMeans: "No coach review: Claude rejected your API key. Replace it in Settings.",
    },
    { fallbackReason: "key_invalid" },
  );
  await openSeededRun(page);
  const coach = region(page, "Coach");

  await expect(
    coach.getByText("No coach review: Claude rejected your API key. Replace it in Settings.", {
      exact: true,
    }),
  ).toBeVisible();
  // Try again stays for a key replaced since the card was written; not the coach's work, so no thumbs.
  await expect(coach.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(coach.getByRole("button", { name: "Helpful", exact: true })).toHaveCount(0);

  await coach.getByRole("link", { name: "Replace key" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(region(page, "Claude").getByText("Saved", { exact: true })).toBeVisible();
  await expect(region(page, "Claude").getByRole("button", { name: "Replace key" })).toBeVisible();
});

test("without a key the run offers only Add Claude key, which opens Settings", async ({ page }) => {
  await seedRun();
  const runId = await openSeededRun(page);
  const coach = region(page, "Coach");

  await expect(coach).toContainText(
    "Add your Claude API key to get a coach review after each run.",
  );
  await expect(coach.getByRole("button")).toHaveCount(0);
  await expect(coach.getByRole("link")).toHaveCount(1);
  expect(await getInsight(page, runId)).toEqual({ state: "no_key" });

  await coach.getByRole("link", { name: "Add Claude key" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(region(page, "Claude").getByLabel("Claude API key")).toBeVisible();
});

test("the owner picks the Claude plan, which replaces the key form and stays after a reload, and API key brings it back", async ({
  page,
}) => {
  await page.goto("/settings");
  const section = region(page, "Claude");
  const choice = section.getByRole("group", { name: "Coach uses" });
  const plan = choice.getByRole("radio", { name: "Claude plan", exact: true });
  const apiKey = choice.getByRole("radio", { name: "API key", exact: true });
  const field = section.getByLabel("Claude API key");

  // Every test starts on a key, and none is saved: the key form is what to fill in.
  await expect(apiKey).toBeChecked();
  await expect(field).toBeVisible();
  expect(await getSettings(page)).toMatchObject({
    claudePlanAvailable: true,
    coachCredential: "none",
  });

  expect((await chooseCredential(page, "Claude plan")).ok()).toBe(true);
  await expect(plan).toBeChecked();
  await expect(section.getByText(planLine, { exact: true })).toBeVisible();
  await expect(field).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Save key" })).toHaveCount(0);
  expect(await getSettings(page)).toMatchObject({ coachCredential: "plan", hasClaudeKey: false });

  await page.reload();
  await expect(plan).toBeChecked();
  await expect(section.getByText(planLine, { exact: true })).toBeVisible();
  await expect(field).toHaveCount(0);

  expect((await chooseCredential(page, "API key")).ok()).toBe(true);
  await expect(apiKey).toBeChecked();
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(section.getByRole("button", { name: "Save key" })).toBeVisible();
  await expect(section.getByText(planLine, { exact: true })).toHaveCount(0);
  expect(await getSettings(page)).toMatchObject({ coachCredential: "none" });
});

test("a Claude plan the server no longer offers says to use an API key and keeps the key form", async ({
  page,
}) => {
  // Settings offered the plan from /api/me, and the server stopped offering it before the tap.
  const refusal = {
    type: "about:blank",
    title: "Conflict",
    status: 409,
    code: ErrorCode.claudePlanUnavailable,
    requestId: "e2e-plan-unavailable",
  } satisfies Problem;
  await page.route("**/api/me/settings", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: refusal.status,
          contentType: "application/problem+json",
          body: JSON.stringify(refusal),
        })
      : route.continue(),
  );
  await page.goto("/settings");
  const section = region(page, "Claude");
  const apiKey = section
    .getByRole("group", { name: "Coach uses" })
    .getByRole("radio", { name: "API key", exact: true });

  expect((await chooseCredential(page, "Claude plan")).status()).toBe(409);

  await expect(section.getByRole("alert")).toHaveText(errorMessages.claude_plan_unavailable);
  await expect(apiKey).toBeChecked();
  await expect(section.getByLabel("Claude API key")).toBeVisible();
  await expect(section.getByText(planLine, { exact: true })).toHaveCount(0);
  expect(await getSettings(page)).toMatchObject({ coachCredential: "none" });
});

test("on the Claude plan without a key, Ask the coach gets the run's card from the coach service, and a thumbs up stays", async ({
  page,
}) => {
  await seedRun();
  // Picking the plan in Settings has its own test; here the run is what is under test.
  const chosen = await page.request.patch("/api/me/settings", {
    data: { coachCredential: "plan" },
  });
  expect(chosen.ok()).toBe(true);
  const runsBefore = await fakeClaudeCodeRuns();
  const runId = await openSeededRun(page);
  const coach = region(page, "Coach");

  // The plan is a credential: the run offers Ask the coach, not Add Claude key.
  await expect(coach.getByText("No coach review for this run yet.", { exact: true })).toBeVisible();
  await expect(coach.getByRole("link", { name: "Add Claude key" })).toHaveCount(0);
  const asked = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(`/${runId}/insight`),
  );
  await coach.getByRole("button", { name: "Ask the coach" }).click();
  expect((await asked).ok()).toBe(true);
  await expect(coach.getByRole("status")).toContainText("The coach is reviewing this run.");

  await expect(coach.getByText(planCard.headline, { exact: true })).toBeVisible({
    timeout: CARD_TIMEOUT_MS,
  });
  await expect(coach.getByRole("heading", { level: 3 })).toHaveText([
    "What happened",
    "What it means",
    "Next",
  ]);
  await expect(coach.getByText(planCard.whatHappened, { exact: true })).toBeVisible();
  await expect(coach.getByText(planCard.whatItMeans, { exact: true })).toBeVisible();
  await expect(coach.getByText(planCard.nextStep, { exact: true })).toBeVisible();
  await expect(coach.getByRole("status")).toHaveCount(0);
  await expect(coach.getByRole("button", { name: "Try again" })).toHaveCount(0);
  // The model's card, not a fallback: written by one run of Claude Code in the coach service, with no
  // key anywhere.
  expect(await getInsight(page, runId)).toMatchObject({
    state: "ready",
    insight: { fallbackReason: null, feedback: null, content: { headline: planCard.headline } },
  });
  expect(await fakeClaudeCodeRuns()).toBe(runsBefore + 1);
  expect(await storedClaudeKey()).toBeNull();

  const helpful = coach.getByRole("button", { name: "Helpful", exact: true });
  await expect(coach.getByRole("button", { name: "Not helpful", exact: true })).toBeVisible();
  const rated = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith("/feedback"),
  );
  await helpful.click();
  expect((await rated).ok()).toBe(true);
  await expect(helpful).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(coach.getByText(planCard.headline, { exact: true })).toBeVisible();
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  // Opened again, the run shows the stored card: no second run.
  expect(await fakeClaudeCodeRuns()).toBe(runsBefore + 1);
});
