import type { GarminActivitySummary } from "@running-coach/shared";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, planSession } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { addDays } from "../../src/lib/local-date";
import { syncGarmin } from "../../src/services/garmin-sync";
import { importHistoryPage } from "../../src/services/history-import";
import { endPause } from "../../src/services/pause";
import { gapReEntry } from "../../src/services/re-entry";
import {
  connectGarmin,
  createPause,
  createPlan,
  createRunAt,
  createRunOn,
  createSession,
  createUser,
  garminBundle,
  nextGarminActivityId,
  PLAN_INPUTS,
  seedImport,
  setSettings,
  storedAdjustments,
  storedSession,
} from "../seed";

// The re-entry after a gap without runs (SPEC: Plan engine, slice 9), through a sync on the real Postgres.
// The Garmin service runs in fixture mode, and its answers are replaced with the runs a test names. Today
// is Wednesday 2026-10-14 in Berlin; the run that ends the gap (R) is synced on Tuesday 10-13, the run
// before it (P) is stored already, and the plan has an easy 8 km on Thursday and Saturday.

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
  await boss.createQueue(bestEffortsQueue.name, bestEffortsQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-10-14T10:00:00Z");
const R_DATE = "2026-10-13";
const PLANNED_M = 8000;

/** A run as Garmin's list answers it, 08:00 in Berlin on `date`. */
function garminRun(
  date: string,
  values: Partial<GarminActivitySummary> = {},
): GarminActivitySummary {
  return {
    garminActivityId: 20_000_000_000 + nextGarminActivityId(),
    type: "running",
    startUtc: `${date}T06:00:00.000Z`,
    startLocal: `${date}T08:00:00`,
    tz: null,
    distanceM: 6000,
    durationS: 2100,
    avgHr: 140,
    maxHr: 152,
    cadence: 168,
    calories: 400,
    elevationGainM: 20,
    isIndoor: false,
    isManual: false,
    eventType: "uncategorized",
    ...values,
  };
}

/** Garmin answers each sync chunk with the named runs on its dates, and no newest-runs list. */
function garminLists(runs: GarminActivitySummary[]) {
  const sync = garminClient.sync.bind(garminClient);
  vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
    const response = await sync(body, options);
    const inChunk = runs.filter((run) => {
      const date = run.startLocal.slice(0, "YYYY-MM-DD".length);
      return date >= body.startDate && date <= body.endDate;
    });
    return { ...response, activities: inChunk, recent: null };
  });
}

/**
 * A Berlin runner with a working Garmin login last synced on Monday (unless `lastSyncAt` says otherwise), P
 * stored `gap` days before R, and a plan made before P (unless `plan` says otherwise) with an easy 8 km on
 * Thursday and Saturday.
 */
async function runner({
  gap,
  plan = {},
  lastSyncAt = new Date("2026-10-12T18:00:00Z"),
}: {
  gap: number;
  plan?: Parameters<typeof createPlan>[1];
  lastSyncAt?: Date;
}) {
  const userId = await createUser();
  await setSettings(userId, { timezone: "Europe/Berlin" });
  await connectGarmin(userId, garminBundle(), { lastSyncAt });
  const previous = await createRunAt(
    userId,
    `${addDays(R_DATE, -gap)} 08:00:00`,
    `${addDays(R_DATE, -gap)}T06:00:00Z`,
  );
  const active = await createPlan(userId, { createdAt: new Date("2026-09-01T00:00:00Z"), ...plan });
  const thursday = await createSession(userId, active.id, { date: "2026-10-15" });
  const saturday = await createSession(userId, active.id, { date: "2026-10-17" });
  return { userId, planId: active.id, previous, thursday, saturday };
}

async function runOn(date: string) {
  const [row] = await db
    .select({ id: activity.id })
    .from(activity)
    .where(eq(activity.startLocal, `${date} 08:00:00`));
  if (!row) throw new Error(`no run on ${date}`);
  return row.id;
}

async function distancesOf(userId: string) {
  const rows = await db
    .select({ date: planSession.date, target: planSession.target })
    .from(planSession)
    .where(eq(planSession.userId, userId))
    .orderBy(asc(planSession.date));
  return rows.map((row) => [row.date, row.target.distanceM]);
}

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

/**
 * Runs `work` while Postgres refuses the statements `when` picks on `table` (a trigger raising an error),
 * then drops the trigger: a real failure of one write, not a mock.
 */
async function whileFailing<T>(
  table: "plan_adjustment" | "plan_session",
  when: "insert" | "status change",
  work: () => Promise<T>,
): Promise<T> {
  await db.execute(sql`
    create or replace function fail_for_test() returns trigger language plpgsql as $$
    begin raise exception 'injected failure'; end $$`);
  await db.execute(
    when === "insert"
      ? sql`create trigger fail_for_test before insert on ${sql.identifier(table)}
          for each row execute function fail_for_test()`
      : sql`create trigger fail_for_test before update on ${sql.identifier(table)}
          for each row when (old.status is distinct from new.status) execute function fail_for_test()`,
  );
  try {
    return await work();
  } finally {
    await db.execute(sql`drop trigger fail_for_test on ${sql.identifier(table)}`);
  }
}

describe("gap re-entry after a sync", () => {
  it.each([
    [7, 0.7],
    [13, 0.7],
    [14, 0.5],
  ])(
    "eases the next sessions after %i days without a run to %d of plan, logged against the run, and queues a push",
    async (gap, factor) => {
      const { userId, thursday, saturday } = await runner({ gap });
      garminLists([garminRun(R_DATE)]);

      await syncGarmin({ userId, now: NOW });

      const eased = PLANNED_M * factor;
      expect((await storedSession(thursday.id)).target.distanceM).toBe(eased);
      expect((await storedSession(saturday.id)).target.distanceM).toBe(eased);
      const rows = await storedAdjustments(userId);
      expect(rows.map((row) => row.planSessionId).toSorted()).toEqual(
        [thursday.id, saturday.id].toSorted(),
      );
      for (const row of rows) {
        expect(row).toMatchObject({
          source: "gap",
          kind: "re_entry",
          outcome: "applied",
          reason: null,
          activityId: await runOn(R_DATE),
          requested: { factor, walkRun: false, daysOff: gap },
          applied: { factor, walkRun: false, daysOff: gap },
          before: { type: "easy", status: "planned", target: { distanceM: PLANNED_M } },
          after: { type: "easy", status: "planned", target: { distanceM: eased } },
        });
      }
      expect(await pushJobs(userId)).toHaveLength(1);
    },
  );

  it("changes nothing after 6 days without a run", async () => {
    const { userId } = await runner({ gap: 6 });
    garminLists([garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect(await distancesOf(userId)).toEqual([
      ["2026-10-15", PLANNED_M],
      ["2026-10-17", PLANNED_M],
    ]);
    expect(await storedAdjustments(userId)).toEqual([]);
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("eases once on a double sync, and a second process re-running the gap changes nothing (double sync)", async () => {
    const { userId } = await runner({ gap: 14 });
    garminLists([garminRun(R_DATE)]);
    await syncGarmin({ userId, now: NOW });
    const eased = await distancesOf(userId);
    const logged = await storedAdjustments(userId);

    await syncGarmin({ userId, now: NOW });
    expect(await gapReEntry(userId, NOW)).toBeNull();

    expect(await distancesOf(userId)).toEqual(eased);
    expect(await storedAdjustments(userId)).toEqual(logged);
  });

  it("does not ease a plan built during the gap whose first week, this week, already carries the re-entry (no double re-entry)", async () => {
    const { userId } = await runner({
      gap: 14,
      plan: {
        // Built the morning R was run, 14 days after P: week 1 already starts at half the volume.
        createdAt: new Date("2026-10-13T05:00:00Z"),
        startDate: "2026-10-12",
        inputs: {
          ...PLAN_INPUTS,
          baseline: {
            weeklyVolumesM: [30_000, 30_000, 0, 0],
            longestRunM: 15_000,
            daysSinceLastRun: 14,
          },
        },
      },
    });
    garminLists([garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect(await distancesOf(userId)).toEqual([
      ["2026-10-15", PLANNED_M],
      ["2026-10-17", PLANNED_M],
    ]);
    expect(await storedAdjustments(userId)).toEqual([]);
  });

  it("eases a plan built during the gap by what its first week does not carry: 15 days off over a 0.7 baseline run at 0.5 / 0.7, not 0.35 (regenerating a plan)", async () => {
    const { userId, thursday } = await runner({
      gap: 15,
      plan: {
        // The goal saved 8 days after P: week 1, this week, starts at 0.7 of the volume.
        createdAt: new Date("2026-10-06T12:00:00Z"),
        startDate: "2026-10-12",
        inputs: { ...PLAN_INPUTS, baseline: { ...PLAN_INPUTS.baseline, daysSinceLastRun: 8 } },
      },
    });
    garminLists([garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect((await storedSession(thursday.id)).target.distanceM).toBeCloseTo(
      (PLANNED_M * 0.5) / 0.7,
      -2,
    );
    const rows = await storedAdjustments(userId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.requested).toEqual({ factor: 0.5, walkRun: false, daysOff: 15 });
    expect((rows[0]?.applied as { factor: number }).factor).toBeCloseTo(0.5 / 0.7, 10);
  });

  it("eases a plan saved before the first sync by the full re-entry when that sync stores two runs 9 days apart: a baseline without runs carries nothing (regenerating a plan, partial sync)", async () => {
    const userId = await createUser();
    await setSettings(userId, { timezone: "Europe/Berlin" });
    await connectGarmin(userId, garminBundle());
    // The goal saved before any run was stored: week 1, this week, starts at the distance's floor.
    const active = await createPlan(userId, {
      createdAt: new Date("2026-10-11T12:00:00Z"),
      startDate: "2026-10-12",
      inputs: {
        ...PLAN_INPUTS,
        baseline: { weeklyVolumesM: [0, 0, 0, 0], longestRunM: 0, daysSinceLastRun: null },
      },
    });
    const thursday = await createSession(userId, active.id, { date: "2026-10-15" });
    garminLists([garminRun("2026-10-04"), garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M * 0.7);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        source: "gap",
        activityId: await runOn(R_DATE),
        requested: { factor: 0.7, walkRun: false, daysOff: 9 },
        applied: { factor: 0.7, walkRun: false, daysOff: 9 },
      }),
    ]);
    expect(await gapReEntry(userId, NOW)).toBeNull();
  });

  it("eases once, keyed on the first run back, when one sync inserts three runs after 10 days off", async () => {
    const { userId, thursday, saturday } = await runner({ gap: 12 });
    garminLists([garminRun("2026-10-11"), garminRun("2026-10-12"), garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M * 0.7);
    expect((await storedSession(saturday.id)).target.distanceM).toBe(PLANNED_M * 0.7);
    const rows = await storedAdjustments(userId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        source: "gap",
        activityId: await runOn("2026-10-11"),
        requested: { factor: 0.7, walkRun: false, daysOff: 10 },
      });
    }
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("eases once, keyed on the first of two runs on the comeback day", async () => {
    const { userId, thursday } = await runner({ gap: 10 });
    garminLists([
      garminRun(R_DATE),
      garminRun(R_DATE, {
        startUtc: "2026-10-13T16:00:00.000Z",
        startLocal: "2026-10-13T18:00:00",
      }),
    ]);

    await syncGarmin({ userId, now: NOW });

    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M * 0.7);
    const rows = await storedAdjustments(userId);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.activityId).toBe(await runOn(R_DATE));
  });

  it("applies a gap re-entry that failed on the next sync, which checks the last 7 days again (partial sync)", async () => {
    const { userId, thursday } = await runner({ gap: 14 });
    garminLists([garminRun(R_DATE)]);

    await whileFailing("plan_adjustment", "insert", () => syncGarmin({ userId, now: NOW }));
    expect(await storedAdjustments(userId)).toEqual([]);
    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M);

    await syncGarmin({ userId, now: NOW });

    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M * 0.5);
    expect(await storedAdjustments(userId)).toHaveLength(2);
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("still eases the gap when run matching fails in the same sync (partial sync)", async () => {
    const { userId, planId, thursday } = await runner({ gap: 14 });
    const tuesday = await createSession(userId, planId, { date: R_DATE });
    garminLists([garminRun(R_DATE)]);

    await whileFailing("plan_session", "status change", () => syncGarmin({ userId, now: NOW }));

    expect((await storedSession(tuesday.id)).status).toBe("planned");
    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M * 0.5);
    expect(await storedAdjustments(userId)).toHaveLength(2);
  });

  it("eases a 10-day gap after a pause that ended on the day of the run before it (illness or injury pause)", async () => {
    const { userId, thursday } = await runner({ gap: 10 });
    await createPause(userId, { startedOn: "2026-09-28", endedOn: "2026-10-03" });
    garminLists([garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M * 0.7);
    expect((await storedAdjustments(userId))[0]).toMatchObject({
      requested: { factor: 0.7, walkRun: false, daysOff: 10 },
    });
  });

  it("eases from the day I'm back was tapped when 10 more days pass without a run after it (early I'm back)", async () => {
    const { userId, thursday } = await runner({ gap: 14 });
    await createPause(userId, { startedOn: "2026-09-30", endedOn: "2026-10-03" });
    garminLists([garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M * 0.7);
    expect((await storedAdjustments(userId))[0]).toMatchObject({
      activityId: await runOn(R_DATE),
      requested: { factor: 0.7, walkRun: false, daysOff: 10 },
    });
  });

  it.each([
    ["ended", { startedOn: "2026-10-01", endedOn: "2026-10-10" }],
    [
      "ended on the day of the run, whose I'm back counted it",
      { startedOn: "2026-10-05", endedOn: R_DATE },
    ],
    ["still open", { startedOn: "2026-10-12", endedOn: null }],
  ])(
    "applies nothing more when a pause covers the gap, %s: I'm back eases that return (illness or injury pause)",
    async (_, pause) => {
      const { userId, thursday } = await runner({ gap: 14 });
      await createPause(userId, pause);
      garminLists([garminRun(R_DATE)]);

      await syncGarmin({ userId, now: NOW });

      expect(await storedAdjustments(userId)).toEqual([]);
      expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M);
    },
  );

  it("eases nothing more when an older run of the comeback is uploaded late: the break was eased (late upload, edited activities)", async () => {
    const { userId, thursday } = await runner({ gap: 14 });
    const wednesday = garminRun("2026-10-14", {
      startUtc: "2026-10-14T05:00:00.000Z",
      startLocal: "2026-10-14T07:00:00",
    });
    garminLists([wednesday]);
    await syncGarmin({ userId, now: NOW });
    const eased = await distancesOf(userId);
    const logged = await storedAdjustments(userId);
    expect(logged).toHaveLength(2);
    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M * 0.5);

    // The runner then added Tuesday's run on Garmin.
    vi.restoreAllMocks();
    garminLists([garminRun(R_DATE), wednesday]);
    await syncGarmin({ userId, now: NOW });

    expect(await runOn(R_DATE)).toBeDefined();
    expect(await distancesOf(userId)).toEqual(eased);
    expect(await storedAdjustments(userId)).toEqual(logged);
  });

  it("eases nothing more when a run from before a pause is uploaded after its I'm back, which measured across the run's date (late upload, illness or injury pause)", async () => {
    // P on Thursday 1 October; the runner last synced on Thursday 8 October.
    const { userId } = await runner({
      gap: 12,
      lastSyncAt: new Date("2026-10-08T18:00:00Z"),
    });
    // Friday's run is not on Garmin yet when they pause on Saturday and tap I'm back on Tuesday: 12 days.
    await createPause(userId, { startedOn: "2026-10-10", reason: "break" });
    const { reEntry } = await endPause(userId, new Date("2026-10-13T08:00:00Z"));
    expect(reEntry).toMatchObject({ daysOff: 12, factor: 0.7, sessionsChanged: 2 });
    const eased = await distancesOf(userId);
    expect(eased).toEqual([
      ["2026-10-15", PLANNED_M * 0.7],
      ["2026-10-17", PLANNED_M * 0.7],
    ]);
    const logged = await storedAdjustments(userId);

    // Friday's run reaches Garmin the day after: P to it is 8 days, which I'm back already counted.
    garminLists([garminRun("2026-10-09")]);
    await syncGarmin({ userId, now: NOW });

    expect(await runOn("2026-10-09")).toBeDefined();
    expect(await distancesOf(userId)).toEqual(eased);
    expect(await storedAdjustments(userId)).toEqual(logged);
  });

  it("eases nothing for runs the history import stores: only syncs end a gap", async () => {
    const { userId, thursday } = await runner({ gap: 14 });
    await seedImport(userId);
    const history = garminClient.history.bind(garminClient);
    vi.spyOn(garminClient, "history").mockImplementation(async (body, options) => ({
      ...(await history(body, options)),
      activities: [garminRun(R_DATE)],
      listed: 1,
    }));

    await importHistoryPage({ userId, pageSize: 10 });

    expect(await runOn(R_DATE)).toBeDefined();
    expect(await storedAdjustments(userId)).toEqual([]);
    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M);
  });

  it("eases nothing without an active plan", async () => {
    const userId = await createUser();
    await setSettings(userId, { timezone: "Europe/Berlin" });
    await connectGarmin(userId, garminBundle(), { lastSyncAt: new Date("2026-10-12T18:00:00Z") });
    await createRunOn(userId, "2026-09-29");
    garminLists([garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect(await storedAdjustments(userId)).toEqual([]);
  });
});
