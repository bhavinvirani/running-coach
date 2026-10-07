import {
  ErrorCode,
  type PlanPhase,
  type SessionSteps,
  weeklyReviewSchema,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { planSession, type PlanSessionRow } from "../../src/db/schema";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import * as reviewQueue from "../../src/jobs/weekly-review-queue";
import { config } from "../../src/lib/config";
import { syncGarmin } from "../../src/services/garmin-sync";
import {
  lastEndedWeek,
  latestReview,
  queueWeeklyReview,
  writeWeeklyReview,
} from "../../src/services/weekly-review";
import {
  claudeKey,
  claudeRequests,
  connectGarmin,
  createPlan,
  createRunOn,
  createSession,
  createUser,
  garminBundle,
  setSettings,
  storedSession,
  TEMPO_STEPS,
} from "../seed";
import { createAdjustment, createPause, storedAdjustments } from "../seed-adaptation";
import {
  createReview,
  reviewCardOf,
  reviewFixtureOutput,
  storedContent,
  storedReviews,
} from "../seed-weekly-review";

// The weekly review on the real Postgres against the fake Claude (slice 10): queueing after a sync, the
// job's work with the changes the engine accepts for the coming week, and Today's latest. Today is Monday
// 2026-10-12 in UTC, so the last ended week is 2026-10-05 to 2026-10-11 and the coming week starts today.
// pg-boss runs without workers, so a queued job stays queued; the job itself is in test/jobs.

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(reviewQueue.name, reviewQueue.queue);
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

const NOW = new Date("2026-10-12T10:00:00Z");
const WEEK = "2026-10-05";

function easySteps(distanceM: number): SessionSteps {
  return [{ kind: "run", zone: "easy", distanceM, durationS: null }];
}

interface RunnerOptions {
  email?: string;
  /** Friday's session (s3) as stored. */
  fridayStatus?: PlanSessionRow["status"];
  /** No key: the coach has no credential. */
  noKey?: boolean;
  /** The coming week's phase (s1 to s3), base by default. */
  comingPhase?: PlanPhase;
}

/**
 * A runner in UTC on the fixture's key with a working Garmin login and a plan since 2026-09-28. The
 * reviewed week: Tuesday's easy 8 km done (8.1 km run), Thursday's 8.8 km tempo missed, Sunday's 13 km long
 * run done (13.2 km run), so 21 km of it count for the cap. The coming week: s1 Tuesday's easy 8 km, s2
 * Thursday's 8.8 km tempo, s3 Friday's easy 6 km.
 */
async function runner(fixture: string, options: RunnerOptions = {}) {
  const userId = await createUser(options.email);
  const key = claudeKey(fixture);
  if (!options.noKey) await setSettings(userId, { claudeKey: key });
  await connectGarmin(userId);
  const active = await createPlan(userId);
  const tuesdayRun = await createRunOn(userId, "2026-10-06", {
    distanceM: 8100,
    durationS: 2600,
    avgHr: 141,
  });
  const sundayRun = await createRunOn(userId, "2026-10-11", {
    distanceM: 13_200,
    durationS: 4300,
    avgHr: 149,
  });
  await createSession(userId, active.id, {
    date: "2026-10-06",
    status: "done",
    activityId: tuesdayRun.id,
  });
  const missed = await createSession(userId, active.id, {
    date: "2026-10-08",
    type: "tempo",
    steps: TEMPO_STEPS,
    status: "missed",
  });
  await createSession(userId, active.id, {
    date: "2026-10-11",
    type: "long",
    steps: easySteps(13_000),
    status: "done",
    activityId: sundayRun.id,
  });
  const phase = options.comingPhase ?? "base";
  const s1 = await createSession(userId, active.id, { date: "2026-10-13", phase });
  const s2 = await createSession(userId, active.id, {
    date: "2026-10-15",
    phase,
    type: "tempo",
    steps: TEMPO_STEPS,
  });
  const s3 = await createSession(userId, active.id, {
    date: "2026-10-16",
    phase,
    steps: easySteps(6000),
    status: options.fridayStatus ?? "planned",
  });
  return { userId, key, planId: active.id, tuesdayRun, missed, s1, s2, s3 };
}

/**
 * A runner whose goal was saved on Wednesday of the reviewed week, so the new plan starts on the coming
 * Monday: the replaced plan, superseded, kept Monday's easy 8 km done with its 8.1 km run and Tuesday's
 * easy 8 km missed, and still holds Thursday's tempo planned, stale since the save; the new plan has
 * Tuesday's easy run in the coming week.
 */
async function goalSavedMidWeek(fixture: string) {
  const userId = await createUser();
  const key = claudeKey(fixture);
  await setSettings(userId, { claudeKey: key });
  const replaced = await createPlan(userId, { status: "superseded" });
  const active = await createPlan(userId, { version: 2, startDate: "2026-10-12" });
  const mondayRun = await createRunOn(userId, WEEK, {
    distanceM: 8100,
    durationS: 2600,
    avgHr: 141,
  });
  const monday = await createSession(userId, replaced.id, {
    date: WEEK,
    status: "done",
    activityId: mondayRun.id,
  });
  const tuesday = await createSession(userId, replaced.id, {
    date: "2026-10-06",
    status: "missed",
  });
  await createSession(userId, replaced.id, {
    date: "2026-10-08",
    type: "tempo",
    steps: TEMPO_STEPS,
  });
  await createSession(userId, active.id, { date: "2026-10-13" });
  return { userId, key, monday, tuesday };
}

async function write(userId: string, lastAttempt = false, now = NOW) {
  return writeWeeklyReview(userId, WEEK, { lastAttempt, now });
}

async function onlyReview(userId: string) {
  const rows = await storedReviews(userId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

async function reviewJobs(userId: string, weekStart: string) {
  return getBoss().findJobs(reviewQueue.name, {
    key: reviewQueue.singletonKey({ userId, weekStart }),
  });
}

/** The user message the fake Claude received in the key's first request. */
async function sentMessage(key: string): Promise<string> {
  const [request] = await claudeRequests(key);
  const messages = request?.body.messages as { content: string }[] | undefined;
  return messages?.[0]?.content ?? "";
}

/**
 * The user's plan_adjustment rows in the order of these sessions: the rows of one review share their
 * transaction's created_at, so the log alone has no order among them.
 */
async function rowsInOrder(userId: string, sessions: PlanSessionRow[]) {
  const order = sessions.map((session) => session.id);
  return (await storedAdjustments(userId))
    .filter((row) => row.source === "review")
    .sort((a, b) => order.indexOf(a.planSessionId ?? "") - order.indexOf(b.planSessionId ?? ""));
}

async function expectUnchanged(...sessions: PlanSessionRow[]) {
  for (const session of sessions) {
    const stored = await storedSession(session.id);
    expect({ ...stored, updatedAt: null }).toEqual({ ...session, updatedAt: null });
  }
}

describe("lastEndedWeek", () => {
  it("is the Monday of the week before today's, also on a Monday and a Sunday", () => {
    expect(lastEndedWeek("2026-10-12")).toBe("2026-10-05");
    expect(lastEndedWeek("2026-10-18")).toBe("2026-10-05");
    expect(lastEndedWeek("2026-10-11")).toBe("2026-09-28");
  });
});

describe("queueWeeklyReview", () => {
  it("queues the last ended week's review once however many syncs ask (runs once per user per week)", async () => {
    const { userId } = await runner("weekly-review-valid");

    expect(await queueWeeklyReview(userId, NOW)).toBe(true);
    expect(await queueWeeklyReview(userId, NOW)).toBe(false);
    expect(await queueWeeklyReview(userId, new Date("2026-10-14T10:00:00Z"))).toBe(false);

    const jobs = await reviewJobs(userId, WEEK);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: reviewQueue.jobId({ userId, weekStart: WEEK }),
      data: { userId, weekStart: WEEK },
    });
  });

  it("queues nothing once the week's review is stored, a fallback card too", async () => {
    const { userId } = await runner("weekly-review-valid");
    await createReview(userId, { weekStart: WEEK, model: null, fallbackReason: "key_invalid" });

    expect(await queueWeeklyReview(userId, NOW)).toBe(false);
    expect(await reviewJobs(userId, WEEK)).toHaveLength(0);
  });

  it("ends the week on Sunday night in the runner's zone across the fall-back (time zones and DST): nothing at 22:30 EST on Sunday 1 November, the week of 26 October at 00:30 on Monday", async () => {
    const userId = await createUser();
    await setSettings(userId, {
      timezone: "America/New_York",
      claudeKey: claudeKey("weekly-review-valid"),
    });
    await createRunOn(userId, "2026-10-28");

    // 03:30 UTC is 22:30 on Sunday in New York, an hour after the clocks went back: the week runs on.
    expect(await queueWeeklyReview(userId, new Date("2026-11-02T03:30:00Z"))).toBe(false);
    expect(await reviewJobs(userId, "2026-10-19")).toHaveLength(0);
    expect(await reviewJobs(userId, "2026-10-26")).toHaveLength(0);

    expect(await queueWeeklyReview(userId, new Date("2026-11-02T05:30:00Z"))).toBe(true);
    expect(await reviewJobs(userId, "2026-10-26")).toHaveLength(1);
  });

  it("ends the week at midnight in a zone ahead of UTC (time zones): Asia/Kolkata at 00:01 on Monday queues the week of 5 October", async () => {
    const userId = await createUser();
    await setSettings(userId, {
      timezone: "Asia/Kolkata",
      claudeKey: claudeKey("weekly-review-valid"),
    });
    await createRunOn(userId, "2026-10-07");

    // 18:29 UTC on Sunday is 23:59 in Kolkata: the week has not ended there yet.
    expect(await queueWeeklyReview(userId, new Date("2026-10-11T18:29:00Z"))).toBe(false);
    expect(await queueWeeklyReview(userId, new Date("2026-10-11T18:31:00Z"))).toBe(true);
    expect(await reviewJobs(userId, "2026-10-05")).toHaveLength(1);
  });

  it("queues nothing without a coach credential (no key)", async () => {
    const { userId } = await runner("weekly-review-valid", { noKey: true });

    expect(await queueWeeklyReview(userId, NOW)).toBe(false);
    expect(await reviewJobs(userId, WEEK)).toHaveLength(0);
  });

  it("queues nothing for a week with no run, no session and no pause, and queues a week that held only a pause or a missed session", async () => {
    const empty = await createUser();
    await setSettings(empty, { claudeKey: claudeKey("weekly-review-valid") });
    await createRunOn(empty, "2026-09-30");
    expect(await queueWeeklyReview(empty, NOW)).toBe(false);

    const paused = await createUser("paused@example.com");
    await setSettings(paused, { claudeKey: claudeKey("weekly-review-valid") });
    await createPause(paused, { startedOn: "2026-10-01", endedOn: "2026-10-06" });
    expect(await queueWeeklyReview(paused, NOW)).toBe(true);

    const missed = await createUser("missed@example.com");
    await setSettings(missed, { claudeKey: claudeKey("weekly-review-valid") });
    const active = await createPlan(missed);
    await createSession(missed, active.id, { date: "2026-10-07", status: "missed" });
    expect(await queueWeeklyReview(missed, NOW)).toBe(true);
  });

  it("queues a week whose only training was missed sessions of the plan a goal save replaced, and nothing for one with only that plan's stale planned sessions (race date change)", async () => {
    const missed = await createUser();
    await setSettings(missed, { claudeKey: claudeKey("weekly-review-valid") });
    const replaced = await createPlan(missed, { status: "superseded" });
    await createPlan(missed, { version: 2, startDate: "2026-10-12" });
    await createSession(missed, replaced.id, { date: WEEK, status: "missed" });
    await createSession(missed, replaced.id, { date: "2026-10-06", status: "missed" });
    expect(await queueWeeklyReview(missed, NOW)).toBe(true);

    const stale = await createUser("stale@example.com");
    await setSettings(stale, { claudeKey: claudeKey("weekly-review-valid") });
    const old = await createPlan(stale, { status: "superseded" });
    await createPlan(stale, { version: 2, startDate: "2026-10-12" });
    await createSession(stale, old.id, { date: "2026-10-08" });
    await createSession(stale, old.id, { date: "2026-10-09", status: "moved" });
    expect(await queueWeeklyReview(stale, NOW)).toBe(false);
  });

  it("does not count a pause that ended on the week's Monday: its last paused day was the Sunday before", async () => {
    const userId = await createUser();
    await setSettings(userId, { claudeKey: claudeKey("weekly-review-valid") });
    await createPause(userId, { startedOn: "2026-09-29", endedOn: WEEK });

    expect(await queueWeeklyReview(userId, NOW)).toBe(false);
  });

  it("is queued by a sync that failed too, after the plan is matched (token expiry)", async () => {
    const userId = await createUser();
    await setSettings(userId, { claudeKey: claudeKey("weekly-review-valid") });
    await connectGarmin(userId, garminBundle("expired"));
    await createRunOn(userId, "2026-10-07");

    await expect(syncGarmin({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminAuthExpired,
    });

    expect(await reviewJobs(userId, WEEK)).toHaveLength(1);
  });
});

describe("writeWeeklyReview", () => {
  it("stores the coach's review of the week with the week's numbers, and changes nothing when it proposes nothing", async () => {
    const { userId, key, planId, s1, s2, s3 } = await runner("weekly-review-valid");

    const outcome = await write(userId);

    const review = await onlyReview(userId);
    expect(outcome).toEqual({
      status: "stored",
      coachMessageId: review.id,
      fallbackReason: null,
      changed: false,
    });
    expect(review).toMatchObject({
      weekStart: WEEK,
      planId,
      promptVersion: "weekly-review/v1",
      model: config.COACH_MODEL,
      fallbackReason: null,
      usage: { inputTokens: 1420, outputTokens: 188 },
    });
    expect(storedContent(review)).toEqual({
      card: reviewCardOf(reviewFixtureOutput("weekly-review-valid")),
      summary: {
        runs: 2,
        distanceM: 21_300,
        durationS: 6900,
        sessionsPlanned: 3,
        sessionsDone: 2,
        plannedDistanceM: 29_800,
        paused: false,
      },
      notes: {},
    });
    expect(await storedAdjustments(userId)).toEqual([]);
    await expectUnchanged(s1, s2, s3);
    expect(await pushJobs(userId)).toHaveLength(0);
    expect(await claudeRequests(key)).toHaveLength(1);
  });

  it("sends the week as stored and labels the coming week's sessions by date, plan sessions before custom ones, each marked as the engine would take a change", async () => {
    const { userId, key, planId } = await runner("weekly-review-valid");
    await createSession(userId, null, { date: "2026-10-13", title: "Strides" });
    await createSession(userId, planId, {
      date: "2026-10-18",
      type: "race",
      steps: easySteps(10_000),
    });

    await write(userId);

    const message = await sentMessage(key);
    expect(message).toContain("Week reviewed: Monday 5 October 2026 to Sunday 11 October 2026");
    expect(message).toContain("Thursday 8 October 2026: Tempo");
    expect(message).toMatch(/Thursday 8 October 2026: .*Status: missed\. Run: none\./);
    expect(message).toMatch(/- s1, Tuesday 13 October 2026: .*Status: planned\. May change\./);
    expect(message).toMatch(/- s2, Tuesday 13 October 2026: Strides .*Fixed\./);
    expect(message).toMatch(/- s3, Thursday 15 October 2026: .*May change\./);
    expect(message).toMatch(/- s5, Sunday 18 October 2026: .*Fixed\./);
    expect(message).toContain("Coming week: week 3 of the plan, base phase");
    expect(message).toContain("Changes to the coming week: allowed");
    expect(message).not.toContain(userId);
  });

  it("applies the changes within the caps in date order: a scale of 1.3 on an easy run is logged clamped and grows it only to the week's cap, a tempo turns easy and a rest skips its session (plan changes clamped)", async () => {
    const { userId, s1, s2, s3 } = await runner("weekly-review-changes");

    const outcome = await write(userId);

    const review = await onlyReview(userId);
    expect(outcome).toMatchObject({ status: "stored", changed: true });
    // 10% over the 21 km of the week before is 23.1 km: with s2 and s3's 14.8 km, s1 may reach 8.3 km.
    expect((await storedSession(s1.id)).target.distanceM).toBe(8300);
    expect(await storedSession(s2.id)).toMatchObject({ type: "easy", status: "planned" });
    expect((await storedSession(s2.id)).target.distanceM).toBe(7700);
    expect((await storedSession(s3.id)).status).toBe("skipped");
    expect(await rowsInOrder(userId, [s1, s2, s3])).toEqual([
      expect.objectContaining({
        planSessionId: s1.id,
        source: "review",
        kind: "scale",
        outcome: "clamped",
        reason: null,
        requested: { kind: "scale", factor: 1.3 },
        applied: { kind: "scale", factor: 1.0375 },
        coachMessageId: review.id,
        activityId: null,
      }),
      expect.objectContaining({ planSessionId: s2.id, kind: "easy", outcome: "applied" }),
      expect.objectContaining({ planSessionId: s3.id, kind: "rest", outcome: "applied" }),
    ]);
    const [first, second, third] = reviewFixtureOutput("weekly-review-changes").changes;
    expect(storedContent(review).notes).toEqual({
      [s1.id]: first!.note,
      [s2.id]: second!.note,
      [s3.id]: third!.note,
    });
    expect(storedContent(review).card).toEqual(
      reviewCardOf(reviewFixtureOutput("weekly-review-changes")),
    );
  });

  it("queues a workout push after a change", async () => {
    const { userId } = await runner("weekly-review-changes");

    await write(userId);

    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it.each(["taper", "race"] as const)(
    "lets no session of a coming %s week rise: s1's 1.3 clamps to no rise and is logged rejected no_change, while the tempo still turns easy and the rest still skips",
    async (phase) => {
      const { userId, s1, s2, s3 } = await runner("weekly-review-changes", { comingPhase: phase });

      const outcome = await write(userId);

      expect(outcome).toMatchObject({ status: "stored", changed: true });
      await expectUnchanged(s1);
      expect(await storedSession(s2.id)).toMatchObject({ type: "easy", status: "planned" });
      expect((await storedSession(s3.id)).status).toBe("skipped");
      expect(await rowsInOrder(userId, [s1, s2, s3])).toEqual([
        expect.objectContaining({
          planSessionId: s1.id,
          kind: "scale",
          outcome: "rejected",
          reason: "no_change",
          requested: { kind: "scale", factor: 1.3 },
          applied: null,
          after: null,
        }),
        expect.objectContaining({ planSessionId: s2.id, kind: "easy", outcome: "applied" }),
        expect.objectContaining({ planSessionId: s3.id, kind: "rest", outcome: "applied" }),
      ]);
      expect(Object.keys(storedContent(await onlyReview(userId)).notes).sort()).toEqual(
        [s2.id, s3.id].sort(),
      );
    },
  );

  it.each(["build", "peak"] as const)(
    "still lets an easy run of a coming %s week rise to the week's cap (plan changes clamped)",
    async (phase) => {
      const { userId, s1 } = await runner("weekly-review-changes", { comingPhase: phase });

      await write(userId);

      expect((await storedSession(s1.id)).target.distanceM).toBe(8300);
      expect(
        (await storedAdjustments(userId)).find((row) => row.planSessionId === s1.id),
      ).toMatchObject({ outcome: "clamped", applied: { kind: "scale", factor: 1.0375 } });
    },
  );

  it("lets two rises share the week's cap: the first by date rises in full, the second only to what is left (plan changes clamped)", async () => {
    const userId = await createUser();
    await setSettings(userId, { claudeKey: claudeKey("weekly-review-two-rises") });
    const active = await createPlan(userId);
    const tuesdayRun = await createRunOn(userId, "2026-10-06", { distanceM: 8200 });
    const sundayRun = await createRunOn(userId, "2026-10-11", { distanceM: 7500 });
    await createSession(userId, active.id, {
      date: "2026-10-06",
      status: "done",
      activityId: tuesdayRun.id,
    });
    await createSession(userId, active.id, {
      date: "2026-10-11",
      steps: easySteps(7500),
      status: "done",
      activityId: sundayRun.id,
    });
    // Listed in the coach's order s1, s2, and decided by date: Thursday's after Tuesday's.
    const thursday = await createSession(userId, active.id, { date: "2026-10-15" });
    const tuesday = await createSession(userId, active.id, { date: "2026-10-13" });

    await write(userId);

    // 10% over 15.5 km is 17.05 km: Tuesday takes its 10% to 8.8 km, Thursday only 8.2 km.
    expect((await storedSession(tuesday.id)).target.distanceM).toBe(8800);
    expect((await storedSession(thursday.id)).target.distanceM).toBe(8200);
    expect(await rowsInOrder(userId, [tuesday, thursday])).toEqual([
      expect.objectContaining({ planSessionId: tuesday.id, outcome: "applied" }),
      expect.objectContaining({ planSessionId: thursday.id, outcome: "clamped" }),
    ]);
  });

  it("rejects an unknown label as no_session, logged without a session, and changes nothing", async () => {
    const { userId, s1, s2, s3 } = await runner("weekly-review-unknown-label");

    const outcome = await write(userId);

    expect(outcome).toMatchObject({ status: "stored", changed: false });
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        planSessionId: null,
        source: "review",
        kind: "rest",
        outcome: "rejected",
        reason: "no_session",
        requested: { kind: "rest" },
        applied: null,
        before: null,
        after: null,
      }),
    ]);
    expect(storedContent(await onlyReview(userId)).notes).toEqual({});
    await expectUnchanged(s1, s2, s3);
    expect(await pushJobs(userId)).toHaveLength(0);
  });

  it("never lets the run coach and a review both change one session: one the coach changed after a run is fixed in the prompt and rejected adjusted, the others still change", async () => {
    const { userId, key, tuesdayRun, s1, s2, s3 } = await runner("weekly-review-changes");
    await createAdjustment(userId, s1, { activityId: tuesdayRun.id });

    await write(userId);

    expect(await sentMessage(key)).toMatch(/- s1, .*Fixed\./);
    await expectUnchanged(s1);
    expect((await storedSession(s2.id)).type).toBe("easy");
    expect((await storedSession(s3.id)).status).toBe("skipped");
    expect(await rowsInOrder(userId, [s1, s2, s3])).toEqual([
      expect.objectContaining({ planSessionId: s1.id, outcome: "rejected", reason: "adjusted" }),
      expect.objectContaining({ planSessionId: s2.id, outcome: "applied" }),
      expect.objectContaining({ planSessionId: s3.id, outcome: "applied" }),
    ]);
    expect(Object.keys(storedContent(await onlyReview(userId)).notes).sort()).toEqual(
      [s2.id, s3.id].sort(),
    );
  });

  it("sends missed and moved sessions as stored and never catches one up: the missed tempo stays missed and leaves the week's cap (missed or moved sessions)", async () => {
    const { userId, key, missed, s1, s3 } = await runner("weekly-review-changes", {
      fridayStatus: "moved",
    });

    await write(userId);

    const message = await sentMessage(key);
    expect(message).toMatch(/Thursday 8 October 2026: .*Status: missed\./);
    expect(message).toMatch(
      /- s3, Friday 16 October 2026: .*Status: moved to this day by the runner\. May change\./,
    );
    expect(await storedSession(missed.id)).toEqual(missed);
    expect(await db.select().from(planSession).where(eq(planSession.userId, userId))).toHaveLength(
      6,
    );
    // Counted, the missed 8.8 km would have let s1 reach its full 10%, 8.8 km.
    expect((await storedSession(s1.id)).target.distanceM).toBe(8300);
    expect((await storedSession(s3.id)).status).toBe("skipped");
  });

  it("reviews a paused week as paused, with the pause in the prompt, and lets no session of the week after rise (illness or injury pause)", async () => {
    const { userId, key, s1, s2, s3 } = await runner("weekly-review-changes");
    await createPause(userId, { startedOn: "2026-10-07", endedOn: "2026-10-09" });

    await write(userId);

    const review = await onlyReview(userId);
    expect(storedContent(review).summary.paused).toBe(true);
    const message = await sentMessage(key);
    expect(message).toContain(
      "Training pause: sick, from Wednesday 7 October 2026, ended Friday 9 October 2026",
    );
    expect(message).toContain("Changes to the coming week: allowed");
    await expectUnchanged(s1);
    expect((await storedSession(s2.id)).type).toBe("easy");
    expect((await storedSession(s3.id)).status).toBe("skipped");
    expect(await rowsInOrder(userId, [s1, s2, s3])).toEqual([
      expect.objectContaining({ planSessionId: s1.id, outcome: "rejected", reason: "no_change" }),
      expect.objectContaining({ planSessionId: s2.id, outcome: "applied" }),
      expect.objectContaining({ planSessionId: s3.id, outcome: "applied" }),
    ]);
  });

  it("rejects every change as paused while a pause is open, and tells the prompt no change is allowed (illness or injury pause)", async () => {
    const { userId, key, s1, s2, s3 } = await runner("weekly-review-changes");
    await createPause(userId, { startedOn: "2026-10-11", reason: "injured" });

    const outcome = await write(userId);

    expect(outcome).toMatchObject({ status: "stored", changed: false });
    expect(storedContent(await onlyReview(userId)).summary.paused).toBe(true);
    const message = await sentMessage(key);
    expect(message).toContain("Changes to the coming week: not allowed (training is paused)");
    expect(message).toMatch(/- s1, .*Fixed\./);
    expect((await storedAdjustments(userId)).map((row) => row.reason)).toEqual([
      "paused",
      "paused",
      "paused",
    ]);
    await expectUnchanged(s1, s2, s3);
    expect(await pushJobs(userId)).toHaveLength(0);
  });

  it("tells the prompt about a pause opened on the Monday after the week and still open, and rejects every change as paused (illness or injury pause)", async () => {
    const { userId, key, s1, s2, s3 } = await runner("weekly-review-changes");
    await createPause(userId, { startedOn: "2026-10-12" });

    const outcome = await write(userId);

    expect(outcome).toMatchObject({ status: "stored", changed: false });
    expect(storedContent(await onlyReview(userId)).summary.paused).toBe(false);
    const message = await sentMessage(key);
    expect(message).toContain(
      "Training pause: none\nTraining pause now: sick, since Monday 12 October 2026, still open\n",
    );
    expect(message).toContain("Changes to the coming week: not allowed (training is paused)");
    expect((await storedAdjustments(userId)).map((row) => row.reason)).toEqual([
      "paused",
      "paused",
      "paused",
    ]);
    await expectUnchanged(s1, s2, s3);
    expect(await pushJobs(userId)).toHaveLength(0);
  });

  it("stores a fallback card that tells a runner paused after the week to rest, never to run the coming week as planned (illness or injury pause, invalid Claude key)", async () => {
    const { userId } = await runner("key-invalid");
    await createPause(userId, { startedOn: "2026-10-12" });

    await write(userId);

    const { card } = storedContent(await onlyReview(userId));
    expect(card.nextWeek).toBe(
      "Training has been paused since Monday 12 October 2026. Rest until you feel well, then tap I'm back on Today. See a doctor or physio if it does not get better.",
    );
    expect(JSON.stringify(card)).not.toMatch(/as planned/);
  });

  it("reviews a week a goal save cut in two from the plan that held it: the replaced plan's done session with its run and its missed one, no extra run, and not its stale planned one (race date change, regenerating a plan without losing history)", async () => {
    const { userId, key, monday, tuesday } = await goalSavedMidWeek("weekly-review-valid");

    await write(userId);

    const message = await sentMessage(key);
    expect(message).toContain("Sessions done: 1 of 2 planned");
    expect(message).toMatch(
      /- Monday 5 October 2026: Easy \(easy\), .*Status: done\. Run: 8\.1 km in 43:20 /,
    );
    expect(message).toMatch(
      /- Tuesday 6 October 2026: Easy \(easy\), .*Status: missed\. Run: none\./,
    );
    expect(message).not.toContain("Thursday 8 October 2026");
    expect(message).toContain("Runs without a session: none");
    expect(message).toContain("Coming week: week 1 of the plan, base phase");
    expect(storedContent(await onlyReview(userId)).summary).toEqual({
      runs: 1,
      distanceM: 8100,
      durationS: 2600,
      sessionsPlanned: 2,
      sessionsDone: 1,
      plannedDistanceM: monday.target.distanceM + tuesday.target.distanceM,
      paused: false,
    });
  });

  it("takes each day of the week from the plan version that held it after two goal saves in it, so a run never counts against two versions (regenerating a plan without losing history)", async () => {
    const userId = await createUser();
    const key = claudeKey("weekly-review-valid");
    await setSettings(userId, { claudeKey: key });
    // Saved on Monday morning after the run, so the second plan held Monday; saved again on Wednesday.
    const first = await createPlan(userId, { status: "superseded" });
    const second = await createPlan(userId, {
      version: 2,
      status: "superseded",
      startDate: WEEK,
    });
    const third = await createPlan(userId, { version: 3, startDate: "2026-10-12" });
    const run = await createRunOn(userId, WEEK, { distanceM: 8100, durationS: 2600 });
    await createSession(userId, first.id, {
      date: WEEK,
      title: "First plan run",
      status: "done",
      activityId: run.id,
    });
    await createSession(userId, second.id, {
      date: WEEK,
      title: "Second plan run",
      status: "done",
      activityId: run.id,
    });
    await createSession(userId, third.id, { date: "2026-10-13" });

    await write(userId);

    const message = await sentMessage(key);
    expect(message).toContain("Second plan run");
    expect(message).not.toContain("First plan run");
    expect(message).toContain("Sessions done: 1 of 1 planned");
    expect(storedContent(await onlyReview(userId)).summary).toMatchObject({
      runs: 1,
      sessionsPlanned: 1,
      sessionsDone: 1,
    });
  });

  it("reviews a runner without a plan from the runs alone and changes nothing", async () => {
    const userId = await createUser();
    const key = claudeKey("weekly-review-changes");
    await setSettings(userId, { claudeKey: key });
    await createRunOn(userId, "2026-10-07");

    await write(userId);

    const review = await onlyReview(userId);
    expect(review.planId).toBeNull();
    expect(await sentMessage(key)).toContain("Plan: none");
    expect((await storedAdjustments(userId)).map((row) => row.reason)).toEqual([
      "no_session",
      "no_session",
      "no_session",
    ]);
  });

  it("stores the key_invalid fallback card at once for a rejected key and leaves the plan alone (invalid Claude key)", async () => {
    const { userId, s1, s2, s3 } = await runner("key-invalid");

    const outcome = await write(userId);

    const review = await onlyReview(userId);
    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "key_invalid" });
    expect(review).toMatchObject({ model: null, fallbackReason: "key_invalid" });
    expect(weeklyReviewSchema.safeParse(storedContent(review).card).success).toBe(true);
    expect(storedContent(review).card.headline).not.toBe("");
    expect(await storedAdjustments(userId)).toEqual([]);
    await expectUnchanged(s1, s2, s3);
  });

  it.each([
    ["timeout", "timeout"],
    ["unavailable", "unavailable"],
  ] as const)(
    "throws claude_unavailable and stores nothing before the last attempt, then stores the fallback card on it (Claude %s)",
    async (fixture, reason) => {
      const { userId, s1, s2, s3 } = await runner(fixture);

      await expect(write(userId)).rejects.toMatchObject({ code: ErrorCode.claudeUnavailable });
      expect(await storedReviews(userId)).toHaveLength(0);

      const outcome = await write(userId, true);

      expect(outcome).toMatchObject({ status: "stored", fallbackReason: reason });
      expect((await onlyReview(userId)).model).toBeNull();
      await expectUnchanged(s1, s2, s3);
    },
  );

  it.each(["invalid-json", "weekly-review-too-many-changes", "weekly-review-change-no-note"])(
    "stores the invalid_output fallback card and changes nothing for output outside the schema (invalid output: %s)",
    async (fixture) => {
      const { userId, s1, s2, s3 } = await runner(fixture);

      const outcome = await write(userId);

      expect(outcome).toMatchObject({ status: "stored", fallbackReason: "invalid_output" });
      expect(await storedAdjustments(userId)).toEqual([]);
      await expectUnchanged(s1, s2, s3);
      expect(await pushJobs(userId)).toHaveLength(0);
    },
  );

  it("makes no second call, card or change on a second write for the week (a retry after the card is stored replays nothing)", async () => {
    const { userId, key, s1 } = await runner("weekly-review-changes");
    await write(userId);
    const adjustments = await storedAdjustments(userId);

    expect(await write(userId)).toEqual({ status: "skipped", reason: "has_review" });
    expect(await write(userId, true)).toEqual({ status: "skipped", reason: "has_review" });

    expect(await claudeRequests(key)).toHaveLength(1);
    expect(await storedReviews(userId)).toHaveLength(1);
    expect(await storedAdjustments(userId)).toEqual(adjustments);
    expect((await storedSession(s1.id)).target.distanceM).toBe(8300);
  });

  it("stores one review and one set of changes when two writes for the week run at once (a daily job firing twice)", async () => {
    const { userId, s1 } = await runner("weekly-review-changes");

    const outcomes = await Promise.all([write(userId), write(userId)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["skipped", "stored"]);
    expect(await storedReviews(userId)).toHaveLength(1);
    expect(await storedAdjustments(userId)).toHaveLength(3);
    expect((await storedSession(s1.id)).target.distanceM).toBe(8300);
  });

  it("replaces a fallback card with the coach's review on a later write, with new thumbs", async () => {
    const { userId } = await runner("key-invalid");
    await write(userId);
    const fallback = await onlyReview(userId);
    await setSettings(userId, { claudeKey: claudeKey("weekly-review-valid") });

    const outcome = await write(userId);

    const review = await onlyReview(userId);
    expect(outcome).toMatchObject({ status: "stored", coachMessageId: fallback.id });
    expect(review).toMatchObject({
      id: fallback.id,
      model: config.COACH_MODEL,
      fallbackReason: null,
    });
  });

  it("skips without a coach credential (no key) and stores nothing", async () => {
    const { userId } = await runner("weekly-review-valid", { noKey: true });

    expect(await write(userId)).toEqual({ status: "skipped", reason: "no_key" });
    expect(await storedReviews(userId)).toHaveLength(0);
  });
});

describe("latestReview", () => {
  it("is ready with the last ended week's review while the week after it holds today, and none from the next Monday", async () => {
    const userId = await createUser();
    const review = await createReview(userId, { weekStart: WEEK });

    expect(await latestReview(userId, NOW)).toMatchObject({
      state: "ready",
      review: { id: review.id, weekStart: WEEK },
    });
    expect(await latestReview(userId, new Date("2026-10-18T23:00:00Z"))).toMatchObject({
      state: "ready",
    });
    expect(await latestReview(userId, new Date("2026-10-19T00:30:00Z"))).toEqual({ state: "none" });
  });

  it("is pending while the week's job waits, retrying with resumesAt while it waits for the plan's reset, and none without a job", async () => {
    const userId = await createUser();
    expect(await latestReview(userId, NOW)).toEqual({ state: "none" });

    await reviewQueue.enqueueWeeklyReview({ userId, weekStart: WEEK });
    expect(await latestReview(userId, NOW)).toEqual({ state: "pending" });

    const held = await createUser("held@example.com");
    await getBoss().send(
      reviewQueue.name,
      { userId: held, weekStart: WEEK },
      {
        ...reviewQueue.jobOptions,
        singletonKey: reviewQueue.singletonKey({ userId: held, weekStart: WEEK }),
        startAfter: 3600,
      },
    );
    const latest = await latestReview(held, NOW);
    expect(latest.state).toBe("retrying");
    expect(latest.state === "retrying" && latest.resumesAt).toBeTruthy();
  });
});
