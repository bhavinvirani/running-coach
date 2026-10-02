import {
  activityDetailSchema,
  activitySchema,
  activityWeekSchema,
  importProgressSchema,
  meResponseSchema,
  type Activity,
  type ActivityDetail,
  type ActivityWeek,
  type ImportProgress,
  type MeResponse,
} from "@running-coach/shared";

const RUNNER_ID = "5b1f0c9e-3d2a-4f6b-8c7d-9e0a1b2c3d4e";

/** A fictional runner. Parsed with the shared contract so the fixture can never drift from the API. */
export function meFixture(overrides: Partial<MeResponse> = {}): MeResponse {
  return meResponseSchema.parse({
    user: {
      id: RUNNER_ID,
      email: "runner@example.com",
      name: "Sam Example",
    },
    settings: {
      units: "km",
      timezone: "Europe/London",
      coachDetail: "standard",
      hasClaudeKey: false,
    },
    garmin: { status: "ok", lastSyncAt: "2026-09-27T06:12:00Z" },
    ...overrides,
  });
}

/**
 * A fictional outdoor run in London: 10.04 km in 52:18 at 148 bpm, 07:12 local (06:12 UTC, BST), 690 kcal.
 * Parsed with the shared contract like meFixture.
 */
export function activityFixture(overrides: Partial<Activity> = {}): Activity {
  return activitySchema.parse({
    id: "0d6c8a4e-7b1f-4c2d-9e3a-5f6b7c8d9e0f",
    type: "running",
    startUtc: "2026-09-27T06:12:00Z",
    startLocal: "2026-09-27T07:12:00",
    tz: "Europe/London",
    distanceM: 10_040,
    durationS: 3138,
    avgHr: 148,
    maxHr: 171,
    cadence: 172,
    calories: 690,
    elevationGainM: 64,
    isIndoor: false,
    isManual: false,
    ...overrides,
  });
}

/** Lap seconds of activityFixture's ten whole kilometers; an 11th lap of 40 m in 19 s ends the run at 52:18. */
const KM_LAP_SECONDS = [318, 315, 312, 310, 312, 314, 313, 311, 309, 305];
const SAMPLES = 101;

/**
 * What POST /api/activities/:id/detail answers for activityFixture: 11 laps, 101 row-aligned samples over
 * 10.04 km, a fictional 1 km loop in Regent's Park as the route, and five zones adding up to 52:18.
 */
export function activityDetailFixture(overrides: Partial<ActivityDetail> = {}): ActivityDetail {
  const laps = [
    ...KM_LAP_SECONDS.map((durationS, position) => ({
      index: position + 1,
      distanceM: 1000,
      durationS,
      avgHr: 138 + 2 * position,
      avgCadence: 170 + (position % 3),
    })),
    { index: 11, distanceM: 40, durationS: 19, avgHr: 158, avgCadence: 176 },
  ];
  const rows = Array.from({ length: SAMPLES }, (_, row) => row);
  return activityDetailSchema.parse({
    laps,
    streams: {
      elapsedS: rows.map((row) => row * 31.38),
      distanceM: rows.map((row) => row * 100.4),
      hr: rows.map((row) => (row === 0 ? null : 135 + (row % 25))),
      cadence: rows.map((row) => 168 + (row % 7)),
      elevationM: rows.map((row) => 30 + 8 * Math.sin(row / 8)),
      speedMps: rows.map(() => 3.2),
    },
    route: Array.from({ length: 48 }, (_, point) => {
      const angle = (2 * Math.PI * point) / 48;
      // A loop in open ocean, like the Garmin fake's: fixtures hold no real place (tests rule).
      return [0.0015 * Math.sin(angle), -30 + 0.0024 * Math.cos(angle)];
    }),
    hrZones: [
      { zone: 1, lowBpm: 98, seconds: 120 },
      { zone: 2, lowBpm: 118, seconds: 600 },
      { zone: 3, lowBpm: 137, seconds: 1500 },
      { zone: 4, lowBpm: 155, seconds: 800 },
      { zone: 5, lowBpm: 172, seconds: 118 },
    ],
    ...overrides,
  });
}

/**
 * One week of runs as GET /api/activities returns it, totals summed from the runs like the API does.
 * `weekStart` is the Monday; the runs keep the order given, which the API sends newest first.
 */
export function weekFixture(weekStart: string, runs: Activity[]): ActivityWeek {
  return activityWeekSchema.parse({
    weekStart,
    distanceM: runs.reduce((sum, run) => sum + run.distanceM, 0),
    durationS: runs.reduce((sum, run) => sum + run.durationS, 0),
    runs,
  });
}

/** An import that has not started, with the overrides for the status under test. */
export function importProgressFixture(overrides: Partial<ImportProgress> = {}): ImportProgress {
  return importProgressSchema.parse({
    status: "not_started",
    runsStored: 0,
    oldestDate: null,
    startedAt: null,
    finishedAt: null,
    resumeAt: null,
    errorCode: null,
    ...overrides,
  });
}

/**
 * The whole body Better Auth 1.7 sends for a successful sign-in, not just what signInResponseSchema pins, so
 * the tests prove the extra fields are accepted.
 */
export function signInFixture() {
  return {
    redirect: false,
    token: "fake-session-token",
    user: {
      id: RUNNER_ID,
      email: "runner@example.com",
      name: "Sam Example",
      image: null,
      emailVerified: false,
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    },
  };
}
