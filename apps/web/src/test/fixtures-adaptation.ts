import {
  endPauseResponseSchema,
  pauseResponseSchema,
  planChangeSchema,
  planSessionSchema,
  trainingPauseSchema,
  type EndPauseResponse,
  type PauseResponse,
  type PlanChange,
  type PlanSession,
  type ReEntry,
  type SessionSnapshot,
  type TrainingPause,
} from "@running-coach/shared";
import { activityFixture, easyFor, planSessionFixture } from "@/test/fixtures";

// The adaptation's fixtures: sessions done, missed, paused or changed by the coach or a pause, the
// coach's plan change and the pause responses.

/** A session as it stood before or after a change: what the adjustment log keeps of it. */
function snapshotOf(session: PlanSession): SessionSnapshot {
  const { type, title, status, target } = session;
  return { type, title, status, target };
}

/** When the adjusted fixtures were changed: Wed 7 Oct 2026, 18:00 in London. */
const ADJUSTED_AT = "2026-10-07T17:00:00Z";

/**
 * The session of planFixture on a date that a run completed: done, with activityFixture's run (Tue 6 Oct,
 * the plan's first easy run, unless given).
 */
export function doneSessionFixture(
  date = "2026-10-06",
  overrides: Partial<PlanSession> = {},
): PlanSession {
  return planSessionSchema.parse(
    planSessionFixture(date, { status: "done", activityId: activityFixture().id, ...overrides }),
  );
}

/** The session of planFixture on a date that passed with no run: missed, still on its date (Wed 7 Oct). */
export function missedSessionFixture(date = "2026-10-07"): PlanSession {
  return planSessionSchema.parse(planSessionFixture(date, { status: "missed" }));
}

/** The session of planFixture on a date during an open pause: paused, off the watch (Fri 9 Oct). */
export function pausedSessionFixture(date = "2026-10-09"): PlanSession {
  return planSessionSchema.parse(planSessionFixture(date, { paused: true }));
}

/**
 * The intervals on Thu 8 Oct as the coach changed them after activityFixture's run: an easy run of the same
 * 1:04:00, 10.6 km at planFixture's easy pace, instead of 11.6 km of intervals.
 */
export function coachEasySessionFixture(): PlanSession {
  const planned = planSessionFixture("2026-10-08");
  return planSessionSchema.parse({
    ...planned,
    type: "easy",
    target: { distanceM: 10590, durationS: 3840, zone: "easy" },
    steps: [easyFor(3840)],
    adjustment: {
      source: "coach",
      kind: "easy",
      activityId: activityFixture().id,
      original: snapshotOf(planned),
      at: ADJUSTED_AT,
    },
  });
}

/** The easy run on Fri 9 Oct as the coach changed it after activityFixture's run: a rest, so skipped. */
export function coachRestSessionFixture(): PlanSession {
  const planned = planSessionFixture("2026-10-09");
  return planSessionSchema.parse({
    ...planned,
    status: "skipped",
    adjustment: {
      source: "coach",
      kind: "rest",
      activityId: activityFixture().id,
      original: snapshotOf(planned),
      at: ADJUSTED_AT,
    },
  });
}

/**
 * The long run on Sun 11 Oct eased for the return after a pause: 70% of the planned 14.0 km, 9.8 km in
 * 59:09. Pass source gap for the return after 7 days without a run and no pause.
 */
export function easedSessionFixture(source: "pause" | "gap" = "pause"): PlanSession {
  const planned = planSessionFixture("2026-10-11");
  return planSessionSchema.parse({
    ...planned,
    target: { distanceM: 9800, durationS: 3549, zone: "easy" },
    steps: [{ kind: "run", zone: "easy", distanceM: 9800, durationS: null }],
    adjustment: {
      source,
      kind: "re_entry",
      activityId: source === "gap" ? activityFixture().id : null,
      original: snapshotOf(planned),
      at: ADJUSTED_AT,
    },
  });
}

/**
 * A session left in a pause when the runner tapped I'm back: skipped by the pause, off the watch. The easy
 * run on Fri 9 Oct unless given.
 */
export function pauseSkippedSessionFixture(date = "2026-10-09"): PlanSession {
  const planned = planSessionFixture(date);
  return planSessionSchema.parse({
    ...planned,
    status: "skipped",
    adjustment: {
      source: "pause",
      kind: "rest",
      activityId: null,
      original: snapshotOf(planned),
      at: ADJUSTED_AT,
    },
  });
}

/** The engine's walk-run round: 4 min run, 1 min walk. */
const WALK_RUN_ROUND_S = 300;

/**
 * A session in the first 7 days back after illness, as the re-entry turned it into walk-run: rounds of
 * 4 min run and 1 min walk filling its time, at least 2, its distance cut by the same share, titled
 * Walk-run and an easy run whatever it was. The easy run on Fri 9 Oct (6 rounds, distance unchanged) unless
 * given; the long run on Sun 11 Oct becomes 16 rounds, the tempo on Thu 15 Oct an easy run.
 */
export function walkRunSessionFixture(date = "2026-10-09"): PlanSession {
  const planned = planSessionFixture(date);
  const rounds = Math.max(Math.floor(planned.target.durationS / WALK_RUN_ROUND_S), 2);
  const durationS = rounds * WALK_RUN_ROUND_S;
  return planSessionSchema.parse({
    ...planned,
    type: "easy",
    title: "Walk-run",
    target: {
      distanceM: Math.round((planned.target.distanceM * durationS) / planned.target.durationS),
      durationS,
      zone: "easy",
    },
    steps: [
      {
        repeat: rounds,
        steps: [
          { kind: "run", zone: "easy", distanceM: null, durationS: 240 },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 60 },
        ],
      },
    ],
    adjustment: {
      source: "pause",
      kind: "re_entry",
      activityId: null,
      original: snapshotOf(planned),
      at: ADJUSTED_AT,
    },
  });
}

/**
 * What the coach changed after activityFixture's run, as its card shows it: the intervals on Thu 8 Oct
 * turned into the easy run of coachEasySessionFixture, as proposed (not clamped).
 */
export function planChangeFixture(overrides: Partial<PlanChange> = {}): PlanChange {
  const before = planSessionFixture("2026-10-08");
  return planChangeSchema.parse({
    sessionId: before.id,
    date: before.date,
    kind: "easy",
    clamped: false,
    before: snapshotOf(before),
    after: snapshotOf(coachEasySessionFixture()),
    ...overrides,
  });
}

/** The runner's open pause: sick since Thu 8 Oct, unless given. */
export function trainingPauseFixture(overrides: Partial<TrainingPause> = {}): TrainingPause {
  return trainingPauseSchema.parse({
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    reason: "sick",
    startDate: "2026-10-08",
    createdAt: "2026-10-08T06:00:00Z",
    ...overrides,
  });
}

/** GET /api/pause and POST /api/pause: the open pause, or null while training runs. */
export function pauseResponseFixture(
  pause: TrainingPause | null = trainingPauseFixture(),
): PauseResponse {
  return pauseResponseSchema.parse({ pause });
}

/**
 * POST /api/pause/end after a sick week and two days: 9 days off, so the next sessions are eased to 70%,
 * and walk-run first. Pass reEntry null for a second tap, when no pause was open.
 */
export function endPauseResponseFixture(reEntry: Partial<ReEntry> | null = {}): EndPauseResponse {
  return endPauseResponseSchema.parse({
    pause: null,
    reEntry:
      reEntry === null
        ? null
        : {
            daysOff: 9,
            factor: 0.7,
            walkRun: true,
            fromDate: "2026-10-17",
            sessionsChanged: 6,
            ...reEntry,
          },
  });
}
