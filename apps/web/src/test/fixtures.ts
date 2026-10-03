import {
  activityDetailSchema,
  activityResponseSchema,
  activitySchema,
  activityWeekSchema,
  calendarResponseSchema,
  garminPushStatusSchema,
  goalSchema,
  importProgressSchema,
  meResponseSchema,
  personalBestSchema,
  personalBestsResponseSchema,
  planResponseSchema,
  planSchema,
  runBestEffortSchema,
  sessionDetailResponseSchema,
  type Activity,
  type ActivityDetail,
  type ActivityResponse,
  type ActivityWeek,
  type CalendarResponse,
  type GarminPushStatus,
  type Goal,
  type ImportProgress,
  type MeResponse,
  type PersonalBest,
  type PersonalBestsResponse,
  type Plan,
  type PlanResponse,
  type PlanSession,
  type RunBestEffort,
  type SessionDetailResponse,
  type SessionSteps,
  type SessionTarget,
  type SessionType,
  type Step,
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
    eventType: null,
    ...overrides,
  });
}

/** Lap seconds of activityFixture's ten whole kilometers; an 11th lap of 40 m in 19 s ends the run at 52:18. */
const KM_LAP_SECONDS = [318, 315, 312, 310, 312, 314, 313, 311, 309, 305];
const SAMPLES = 101;

/**
 * What POST /api/activities/:id/detail answers for activityFixture: 11 laps, 101 row-aligned samples over
 * 10.04 km, a fictional loop in open ocean as the route, and five zones adding up to 52:18.
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
 * One of a run's best efforts: activityFixture's 5K in 27:05 (5:25 /km, unrounded as the API sends it),
 * the runner's current best there.
 */
export function runBestEffortFixture(overrides: Partial<RunBestEffort> = {}): RunBestEffort {
  return runBestEffortSchema.parse({
    distanceKey: "5k",
    timeS: 1625.87,
    personalBest: true,
    ...overrides,
  });
}

/**
 * GET /api/activities/:id for activityFixture: no detail fetched yet and no best efforts computed, with the
 * overrides for the run under test.
 */
export function activityResponseFixture(
  overrides: Partial<ActivityResponse> = {},
): ActivityResponse {
  return activityResponseSchema.parse({
    activity: activityFixture(),
    detail: null,
    bestEfforts: [],
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

/** A best at one distance from activityFixture's run (Sun 27 Sep 2026, 07:12 in London). */
export function personalBestFixture(overrides: Partial<PersonalBest> = {}): PersonalBest {
  return personalBestSchema.parse({
    distanceKey: "5k",
    timeS: 1625.87,
    activityId: activityFixture().id,
    startUtc: "2026-09-27T06:12:00Z",
    startLocal: "2026-09-27T07:12:00",
    ...overrides,
  });
}

/**
 * GET /api/personal-bests before any best: nothing found, nothing from Garmin, nothing pending, no job
 * checking and no reason one stopped.
 */
export function personalBestsFixture(
  overrides: Partial<PersonalBestsResponse> = {},
): PersonalBestsResponse {
  return personalBestsResponseSchema.parse({
    bests: [],
    garmin: null,
    pendingRuns: 0,
    checking: false,
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

const GOAL_ID = "3c2f7f2b-1e7d-4b5c-8b1f-7c8b3f1d2e33";

/**
 * A 10K on Sun 25 Oct 2026 in 49:00, on 4 runs a week with the long run on Sunday, no time typed in.
 * Parsed with the shared contract like meFixture.
 */
export function goalFixture(overrides: Partial<Goal> = {}): Goal {
  return goalSchema.parse({
    id: GOAL_ID,
    kind: "race",
    distanceKey: "10k",
    raceDate: "2026-10-25",
    targetTimeS: 2940,
    daysPerWeek: 4,
    longRunDay: "sun",
    recentTime: null,
    updatedAt: "2026-10-02T08:00:00Z",
    ...overrides,
  });
}

function easyFor(durationS: number): Step {
  return { kind: "run", zone: "easy", distanceM: null, durationS };
}

/** The id of planFixture's session on a date, which no two of its sessions share. */
export function planSessionId(date: string): string {
  return `00000000-0000-4000-8000-${date.replaceAll("-", "")}0000`;
}

/** A planned session of the plan, not yet on Garmin. */
function session(
  date: string,
  type: Exclude<SessionType, "rest">,
  target: SessionTarget,
  steps: SessionSteps,
): PlanSession {
  return {
    id: planSessionId(date),
    date,
    type,
    target,
    steps,
    status: "planned",
    source: "plan",
    title: null,
    activityId: null,
    onGarmin: false,
  };
}

/**
 * planFixture's three weeks: base, build, then the race week as the down week, with every session type the
 * plan shows: easy, intervals, tempo, long, race practice, strength and the race itself. Mondays,
 * Wednesdays (but for strength) and Saturdays are rest days.
 */
function planWeeksFixture(): Plan["weeks"] {
  return [
    {
      number: 1,
      startDate: "2026-10-05",
      phase: "base",
      distanceM: 38030,
      sessions: [
        session("2026-10-06", "easy", { distanceM: 7450, durationS: 2700, zone: "easy" }, [
          easyFor(2700),
        ]),
        session("2026-10-07", "strength", { distanceM: 0, durationS: 1800, zone: null }, []),
        session(
          "2026-10-08",
          "intervals",
          { distanceM: 11610, durationS: 3840, zone: "interval" },
          [
            { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
            {
              repeat: 5,
              steps: [
                { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
                { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
              ],
            },
            { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
          ],
        ),
        session("2026-10-09", "easy", { distanceM: 4970, durationS: 1800, zone: "easy" }, [
          easyFor(1800),
        ]),
        session("2026-10-11", "long", { distanceM: 14000, durationS: 5070, zone: "easy" }, [
          { kind: "run", zone: "easy", distanceM: 14000, durationS: null },
        ]),
      ],
    },
    {
      number: 2,
      startDate: "2026-10-12",
      phase: "build",
      distanceM: 38600,
      sessions: [
        session("2026-10-13", "easy", { distanceM: 7450, durationS: 2700, zone: "easy" }, [
          easyFor(2700),
        ]),
        session("2026-10-14", "strength", { distanceM: 0, durationS: 1800, zone: null }, []),
        session("2026-10-15", "tempo", { distanceM: 8180, durationS: 2716, zone: "threshold" }, [
          { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
          { kind: "work", zone: "threshold", distanceM: 4000, durationS: null },
          { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
        ]),
        session("2026-10-16", "easy", { distanceM: 4970, durationS: 1800, zone: "easy" }, [
          easyFor(1800),
        ]),
        session("2026-10-18", "long", { distanceM: 18000, durationS: 6520, zone: "easy" }, [
          { kind: "run", zone: "easy", distanceM: 18000, durationS: null },
        ]),
      ],
    },
    {
      number: 3,
      startDate: "2026-10-19",
      phase: "race",
      distanceM: 27250,
      sessions: [
        session("2026-10-20", "easy", { distanceM: 6630, durationS: 2400, zone: "easy" }, [
          easyFor(2400),
        ]),
        session("2026-10-22", "race_practice", { distanceM: 7310, durationS: 2448, zone: "race" }, [
          { kind: "warmup", zone: "easy", distanceM: null, durationS: 600 },
          {
            repeat: 3,
            steps: [
              { kind: "work", zone: "race", distanceM: 1000, durationS: null },
              { kind: "recovery", zone: "easy", distanceM: null, durationS: 120 },
            ],
          },
          { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
        ]),
        session("2026-10-23", "easy", { distanceM: 3310, durationS: 1200, zone: "easy" }, [
          easyFor(1200),
        ]),
        session("2026-10-25", "race", { distanceM: 10000, durationS: 2960, zone: "race" }, [
          { kind: "run", zone: "race", distanceM: 10000, durationS: null },
        ]),
      ],
    },
  ];
}

/**
 * goalFixture's plan, version 1, from Mon 5 Oct to race day on Sun 25 Oct: three weeks, under the 8 a 10K
 * plan usually takes, hence its one warning. Paces from a 50:00 10K (VDOT about 41): easy 5:45-6:20,
 * threshold 5:00-5:07, interval 4:45-4:52 and race 4:54-4:58 per km. Parsed with the shared contract.
 */
export function planFixture(overrides: Partial<Plan> = {}): Plan {
  return planSchema.parse({
    id: "2b1f6e1a-0d6c-4a4b-9a0e-6b7a2e0c1d22",
    goalId: GOAL_ID,
    version: 1,
    engineVersion: "0.1.0",
    status: "active",
    startDate: "2026-10-05",
    endDate: "2026-10-25",
    vdot: 41.2,
    vdotSource: {
      origin: "race",
      distanceM: 10000,
      timeS: 3000,
      activityId: activityFixture().id,
      date: "2026-09-27",
    },
    paces: {
      easy: { fastSPerKm: 345, slowSPerKm: 380 },
      marathon: { fastSPerKm: 315, slowSPerKm: 322 },
      threshold: { fastSPerKm: 300, slowSPerKm: 307 },
      interval: { fastSPerKm: 285, slowSPerKm: 292 },
      repetition: { fastSPerKm: 270, slowSPerKm: 275 },
      race: { fastSPerKm: 294, slowSPerKm: 298 },
    },
    warnings: [{ code: "race_date_close", weeks: 3, minimumWeeks: 8 }],
    weeks: planWeeksFixture(),
    createdAt: "2026-10-02T08:00:00Z",
    ...overrides,
  });
}

/** GET /api/plan once goalFixture is saved: the goal and its plan. */
export function planResponseFixture(overrides: Partial<PlanResponse> = {}): PlanResponse {
  return planResponseSchema.parse({ goal: goalFixture(), plan: planFixture(), ...overrides });
}

/** planFixture's sessions, every week's in the order the plan lists them. */
export function planSessionsFixture(): PlanSession[] {
  return planFixture().weeks.flatMap((week) => week.sessions);
}

/** The session of planFixture on a date, with the overrides for the test; throws for a rest day. */
export function planSessionFixture(
  date: string,
  overrides: Partial<PlanSession> = {},
): PlanSession {
  const found = planSessionsFixture().find((candidate) => candidate.date === date);
  if (found === undefined) throw new Error(`planFixture has no session on ${date}`);
  return { ...found, ...overrides };
}

/**
 * A tempo the runner built on Fri 9 Oct, "Hill reps": 15 min warm-up, 4 x (400 m at threshold, 2 min
 * recovery), 10 min cool-down, with the target the engine gives it at planFixture's paces.
 */
export function customSessionFixture(overrides: Partial<PlanSession> = {}): PlanSession {
  return {
    id: "c0ffee00-0000-4000-8000-000000000001",
    date: "2026-10-09",
    type: "tempo",
    target: { distanceM: 7062, durationS: 2464, zone: "threshold" },
    steps: [
      { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
      {
        repeat: 4,
        steps: [
          { kind: "work", zone: "threshold", distanceM: 400, durationS: null },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 120 },
        ],
      },
      { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
    ],
    status: "planned",
    source: "custom",
    title: "Hill reps",
    activityId: null,
    onGarmin: false,
    ...overrides,
  };
}

/** Where sending workouts stands for a runner whose Garmin login works: nothing sending, nothing failed. */
export function garminPushStatusFixture(
  overrides: Partial<GarminPushStatus> = {},
): GarminPushStatus {
  return garminPushStatusSchema.parse({
    connection: "ok",
    pushing: false,
    pushedAt: "2026-10-08T05:00:00Z",
    error: null,
    others: [],
    ...overrides,
  });
}

/**
 * GET /api/calendar from `from` to six days later: planFixture's sessions on those days (and `extra`
 * sessions, a custom one), the plan's paces and the push status. Parsed with the shared contract.
 */
export function calendarFixture(
  from: string,
  { extra = [], ...overrides }: Partial<CalendarResponse> & { extra?: PlanSession[] } = {},
): CalendarResponse {
  const sessions = [...planSessionsFixture(), ...extra];
  const days = Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(`${from}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const date = day.toISOString().slice(0, 10);
    return { date, sessions: sessions.filter((candidate) => candidate.date === date) };
  });
  return calendarResponseSchema.parse({
    days,
    paces: planFixture().paces,
    garmin: garminPushStatusFixture(),
    ...overrides,
  });
}

/** GET /api/sessions/:id: a session (the intervals on Thu 8 Oct unless given), the plan's paces, the push status. */
export function sessionDetailFixture(
  overrides: Partial<SessionDetailResponse> = {},
): SessionDetailResponse {
  return sessionDetailResponseSchema.parse({
    session: planSessionFixture("2026-10-08"),
    paces: planFixture().paces,
    garmin: garminPushStatusFixture(),
    ...overrides,
  });
}
