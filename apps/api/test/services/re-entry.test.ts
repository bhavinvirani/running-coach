import type { GarminActivitySummary } from "@running-coach/shared";
import { asc, eq } from "drizzle-orm";
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
 * A Berlin runner with a working Garmin login last synced on Monday, P stored `gap` days before R, and a
 * plan made before P (unless `plan` says otherwise) with an easy 8 km on Thursday and Saturday.
 */
async function runner({
  gap,
  plan = {},
}: {
  gap: number;
  plan?: Parameters<typeof createPlan>[1];
}) {
  const userId = await createUser();
  await setSettings(userId, { timezone: "Europe/Berlin" });
  await connectGarmin(userId, garminBundle(), { lastSyncAt: new Date("2026-10-12T18:00:00Z") });
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
    expect(await gapReEntry(userId, [await runOn(R_DATE)], NOW)).toBeNull();

    expect(await distancesOf(userId)).toEqual(eased);
    expect(await storedAdjustments(userId)).toEqual(logged);
  });

  it("does not ease a plan built after the gap from a baseline that already carries the re-entry", async () => {
    const { userId } = await runner({
      gap: 14,
      plan: {
        // Built the morning R was run, 14 days after P: week 1 already starts at half the volume.
        createdAt: new Date("2026-10-13T05:00:00Z"),
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

  it.each([
    ["ended", { startedOn: "2026-10-01", endedOn: "2026-10-10" }],
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

  it("ends no break with a late upload of an old run: a newer run is on record", async () => {
    const { userId, thursday } = await runner({ gap: 14 });
    // Synced earlier this morning; the runner then added Tuesday's run on Garmin.
    await createRunAt(userId, "2026-10-14 07:00:00", "2026-10-14T05:00:00Z");
    garminLists([garminRun(R_DATE)]);

    await syncGarmin({ userId, now: NOW });

    expect(await storedAdjustments(userId)).toEqual([]);
    expect((await storedSession(thursday.id)).target.distanceM).toBe(PLANNED_M);
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
