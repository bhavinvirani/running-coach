import { createHash } from "node:crypto";
import { garminWorkout, sessionTarget } from "@running-coach/engine";
import {
  GARMIN_WORKOUT_NAME_MAX,
  type GarminWorkoutResult,
  type SessionSteps,
} from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { localDateOf } from "../../src/lib/local-date";
import {
  desiredWorkout,
  garminColumnsAfter,
  isOnGarmin,
  type PlannedAction,
  planWorkoutPush,
  type PushSession,
  pushWindow,
  workoutName,
} from "../../src/services/workout-push-plan";
import { EASY_STEPS, FASTER_PACES, INTERVAL_STEPS, PACES, TEMPO_STEPS } from "../seed";

// The push's rules as pure functions: which sessions become which Garmin actions, and what each result
// stores. No database or Garmin here; test/jobs/push-workouts.test.ts runs them against both.

const TODAY = "2026-10-01";
const WINDOW = pushWindow(TODAY);
const ACTIVE = { id: "active-plan", paces: PACES };
const OLD_PLAN = "superseded-plan";

let lastId = 0;

/** A planned easy 8 km of the active plan on `date`, holding nothing on Garmin unless `values` say so. */
function session(date: string, values: Partial<PushSession> = {}): PushSession {
  lastId += 1;
  const steps = values.steps ?? EASY_STEPS;
  return {
    id: `session-${String(lastId).padStart(3, "0")}`,
    planId: ACTIVE.id,
    date,
    type: "easy",
    title: null,
    target: sessionTarget(steps, PACES),
    status: "planned",
    garminWorkoutId: null,
    garminScheduleId: null,
    garminDate: null,
    garminHash: null,
    ...values,
    steps,
  };
}

/** The session as the last push left it: uploaded with its current content and scheduled on its date. */
function pushed(base: PushSession, ids = { workoutId: "900", scheduleId: "800" }): PushSession {
  return {
    ...base,
    garminWorkoutId: ids.workoutId,
    garminScheduleId: ids.scheduleId,
    garminDate: base.date,
    garminHash: desiredWorkout(base, PACES, "km")!.hash,
  };
}

function plan(sessions: PushSession[], values: { activePlan?: typeof ACTIVE | null } = {}) {
  return planWorkoutPush({
    window: WINDOW,
    sessions,
    activePlan: values.activePlan === undefined ? ACTIVE : values.activePlan,
    units: "km",
  });
}

const actionsOf = (planned: PlannedAction[]) => planned.map((p) => p.action);

describe("workoutName", () => {
  it("names a session by its type and target distance in km with one decimal", () => {
    const tempo = session(TODAY, { type: "tempo", steps: TEMPO_STEPS });

    expect(tempo.target.distanceM).toBe(8800);
    expect(workoutName(tempo, "km")).toBe("Tempo 8.8 km");
    expect(workoutName({ ...tempo, type: "long" }, "km")).toBe("Long run 8.8 km");
  });

  it("names it in miles for a runner in miles (unit conversion)", () => {
    expect(workoutName(session(TODAY, { type: "easy" }), "mi")).toBe("Easy 5.0 mi");
  });

  it("uses a custom workout's title, and cuts a long one so the distance always shows", () => {
    expect(workoutName(session(TODAY, { title: "Hill reps" }), "km")).toBe("Hill reps 8.0 km");
    const long = workoutName(session(TODAY, { title: "x".repeat(GARMIN_WORKOUT_NAME_MAX) }), "km");

    expect(long).toHaveLength(GARMIN_WORKOUT_NAME_MAX);
    expect(long.endsWith(" 8.0 km")).toBe(true);
  });
});

describe("desiredWorkout", () => {
  it("is the engine's workout at the given paces, hashed as sha256 of its JSON", () => {
    const tempo = session(TODAY, { type: "tempo", steps: TEMPO_STEPS });

    const desired = desiredWorkout(tempo, PACES, "km");

    const workout = garminWorkout({ name: "Tempo 8.8 km", steps: TEMPO_STEPS, paces: PACES });
    expect(desired).toEqual({
      workout,
      hash: createHash("sha256").update(JSON.stringify(workout)).digest("hex"),
    });
  });

  it("changes its hash with the paces, the steps, the title or the units, and only then", () => {
    const base = session(TODAY);
    const hash = (s: PushSession, paces = PACES, units: "km" | "mi" = "km") =>
      desiredWorkout(s, paces, units)?.hash;

    expect(hash(base)).toBe(hash({ ...base, id: "another", status: "moved" }));
    for (const other of [
      hash(base, FASTER_PACES),
      hash({ ...base, steps: INTERVAL_STEPS }),
      hash({ ...base, title: "Shakeout" }),
      hash(base, PACES, "mi"),
    ]) {
      expect(other).not.toBe(hash(base));
    }
  });

  it("is null for rest and strength and for a session without steps", () => {
    expect(desiredWorkout(session(TODAY, { type: "rest" }), PACES, "km")).toBeNull();
    expect(desiredWorkout(session(TODAY, { type: "strength" }), PACES, "km")).toBeNull();
    expect(desiredWorkout(session(TODAY, { steps: [] as SessionSteps }), PACES, "km")).toBeNull();
  });
});

describe("isOnGarmin", () => {
  it("is true only with both ids, scheduled on its date, with the hash of its workout now", () => {
    const onGarmin = pushed(session(TODAY));

    expect(isOnGarmin(onGarmin, PACES, "km")).toBe(true);
    expect(isOnGarmin({ ...onGarmin, garminScheduleId: null }, PACES, "km")).toBe(false);
    expect(isOnGarmin({ ...onGarmin, garminDate: "2026-10-02" }, PACES, "km")).toBe(false);
    expect(isOnGarmin(onGarmin, FASTER_PACES, "km")).toBe(false);
    expect(isOnGarmin(onGarmin, null, "km")).toBe(false);
    expect(isOnGarmin(session(TODAY), PACES, "km")).toBe(false);
  });
});

describe("planWorkoutPush", () => {
  it("creates every wanted session without a workout, on its date, with its workout's hash", () => {
    const easy = session("2026-10-02");

    const planned = plan([easy]);

    const desired = desiredWorkout(easy, PACES, "km")!;
    expect(planned).toEqual([
      {
        action: { action: "create", ref: easy.id, date: "2026-10-02", workout: desired.workout },
        session: easy,
        hash: desired.hash,
      },
    ]);
  });

  it("sends nothing for sessions Garmin already holds as they are (re-push of unchanged sessions)", () => {
    expect(plan([pushed(session(TODAY)), pushed(session("2026-10-04"))])).toEqual([]);
  });

  it("moves a workout scheduled on another day: unschedule that one, schedule the new day (moved session)", () => {
    const moved = {
      ...pushed(session("2026-10-03")),
      date: "2026-10-04",
      status: "moved" as const,
    };

    expect(actionsOf(plan([moved]))).toEqual([
      { action: "move", ref: moved.id, workoutId: 900, scheduleId: 800, date: "2026-10-04" },
    ]);
  });

  it("only schedules a workout that uploaded but never got scheduled (partial push)", () => {
    const uploaded = { ...pushed(session("2026-10-03")), garminScheduleId: null, garminDate: null };

    expect(actionsOf(plan([uploaded]))).toEqual([
      { action: "move", ref: uploaded.id, workoutId: 900, scheduleId: null, date: "2026-10-03" },
    ]);
  });

  it("leaves a scheduled instance on a past day alone when it schedules the workout again", () => {
    const late = {
      ...pushed(session("2026-10-02")),
      garminDate: "2026-09-30",
      status: "moved" as const,
    };

    expect(actionsOf(plan([late]))).toEqual([
      { action: "move", ref: late.id, workoutId: 900, scheduleId: null, date: "2026-10-02" },
    ]);
  });

  it("removes and creates again a workout whose content changed (new paces), removes first", () => {
    const before = pushed(session("2026-10-03"));

    const planned = plan([before], { activePlan: { id: ACTIVE.id, paces: FASTER_PACES } });

    const desired = desiredWorkout(before, FASTER_PACES, "km")!;
    expect(actionsOf(planned)).toEqual([
      { action: "remove", ref: before.id, workoutId: 900, scheduleId: 800 },
      { action: "create", ref: before.id, date: "2026-10-03", workout: desired.workout },
    ]);
    expect(planned[1]?.hash).toBe(desired.hash);
  });

  it("only creates when the changed workout is scheduled on a past day, which is never touched", () => {
    const before = {
      ...pushed(session("2026-10-02")),
      garminDate: "2026-09-30",
      steps: TEMPO_STEPS,
      status: "moved" as const,
    };

    expect(plan([before]).map((p) => p.action.action)).toEqual(["create"]);
  });

  it("removes a superseded plan's workouts from today on and leaves past ones (race date change)", () => {
    const old = (date: string) => pushed({ ...session(date), planId: OLD_PLAN });
    const yesterday = old("2026-09-30");
    const today = old(TODAY);
    const later = old("2026-10-12");

    expect(actionsOf(plan([yesterday, today, later]))).toEqual([
      { action: "remove", ref: today.id, workoutId: 900, scheduleId: 800 },
      { action: "remove", ref: later.id, workoutId: 900, scheduleId: 800 },
    ]);
  });

  it("removes a skipped session's workout and sends nothing for one never pushed (skipped session)", () => {
    const skipped = { ...pushed(session("2026-10-03")), status: "skipped" as const };
    const neverPushed = session("2026-10-04", { status: "skipped" });

    expect(actionsOf(plan([skipped, neverPushed]))).toEqual([
      { action: "remove", ref: skipped.id, workoutId: 900, scheduleId: 800 },
    ]);
  });

  it("never touches done or missed sessions, nor anything before today (missed sessions)", () => {
    const done = { ...pushed(session(TODAY)), status: "done" as const, garminDate: "2026-10-02" };
    const missed = { ...pushed(session("2026-10-02")), status: "missed" as const };
    const past = { ...pushed(session("2026-09-30")), status: "skipped" as const };
    const pastUnpushed = session("2026-09-30");

    expect(plan([done, missed, past, pastUnpushed])).toEqual([]);
  });

  it("removes a workout whose session moved out of the window, and creates it once it is back in", () => {
    const out = { ...pushed(session("2026-10-07")), date: "2026-10-08", status: "moved" as const };

    expect(actionsOf(plan([out]))).toEqual([
      { action: "remove", ref: out.id, workoutId: 900, scheduleId: 800 },
    ]);
    expect(
      plan([{ ...out, garminWorkoutId: null, garminScheduleId: null, garminDate: null }]),
    ).toEqual([]);
  });

  it("covers today and the next six days only", () => {
    const sessions = ["2026-09-30", TODAY, "2026-10-07", "2026-10-08"].map((date) => session(date));

    expect(plan(sessions).map((p) => p.action.action === "create" && p.action.date)).toEqual([
      TODAY,
      "2026-10-07",
    ]);
  });

  it("creates custom workouts at the active plan's paces, and removes a deleted one's", () => {
    const custom = session("2026-10-02", {
      planId: null,
      title: "Hill reps",
      steps: INTERVAL_STEPS,
    });
    const deleted = {
      ...pushed(session("2026-10-03", { planId: null })),
      status: "skipped" as const,
    };

    const planned = plan([custom, deleted]);

    expect(actionsOf(planned)).toEqual([
      { action: "remove", ref: deleted.id, workoutId: 900, scheduleId: 800 },
      {
        action: "create",
        ref: custom.id,
        date: "2026-10-02",
        workout: garminWorkout({ name: "Hill reps 11.8 km", steps: INTERVAL_STEPS, paces: PACES }),
      },
    ]);
  });

  it("wants nothing on Garmin without an active plan, and removes what it holds", () => {
    const custom = session("2026-10-02", { planId: null });
    const held = pushed(session("2026-10-03", { planId: null }));

    expect(actionsOf(plan([custom, held], { activePlan: null }))).toEqual([
      { action: "remove", ref: held.id, workoutId: 900, scheduleId: 800 },
    ]);
  });

  it("never sends rest or strength sessions", () => {
    expect(
      plan([session("2026-10-02", { type: "rest" }), session("2026-10-03", { type: "strength" })]),
    ).toEqual([]);
  });

  it("orders removes, then moves, then creates, each by date", () => {
    const create2 = session("2026-10-05");
    const create1 = session("2026-10-02");
    const move = { ...pushed(session("2026-10-04")), garminDate: "2026-10-03" };
    const remove2 = { ...pushed(session("2026-10-06")), status: "skipped" as const };
    const remove1 = { ...pushed(session(TODAY)), planId: OLD_PLAN };

    const planned = plan([create2, remove2, move, create1, remove1]);

    expect(planned.map((p) => [p.action.action, p.session.id])).toEqual([
      ["remove", remove1.id],
      ["remove", remove2.id],
      ["move", move.id],
      ["create", create1.id],
      ["create", create2.id],
    ]);
  });
});

describe("pushWindow", () => {
  it.each([
    // 23:30 PDT on 2026-10-31, then 00:30 PDT and 23:30 PST on 2026-11-01, the day the clocks go back.
    [
      "America/Los_Angeles before midnight",
      "2026-11-01T06:30:00Z",
      "America/Los_Angeles",
      "2026-10-31",
    ],
    [
      "America/Los_Angeles after midnight (DST)",
      "2026-11-01T07:30:00Z",
      "America/Los_Angeles",
      "2026-11-01",
    ],
    [
      "America/Los_Angeles, end of the fall-back day (DST)",
      "2026-11-02T07:30:00Z",
      "America/Los_Angeles",
      "2026-11-01",
    ],
    // 00:30 NZDT on 2026-10-04 is still 2026-10-03 in UTC.
    [
      "Pacific/Auckland near midnight UTC",
      "2026-10-03T11:30:00Z",
      "Pacific/Auckland",
      "2026-10-04",
    ],
  ])("starts on the runner's local date: %s (time zones)", (_case, instant, timeZone, today) => {
    const window = pushWindow(localDateOf(new Date(instant), timeZone));

    expect(window.start).toBe(today);
    expect(window).toEqual({ start: today, end: pushWindow(today).end });
  });

  it("spans seven local days across month ends and the fall-back (DST)", () => {
    expect(pushWindow("2026-10-28")).toEqual({ start: "2026-10-28", end: "2026-11-03" });
  });
});

describe("garminColumnsAfter", () => {
  const before = pushed(session("2026-10-03"));
  const moved = { ...before, date: "2026-10-04" };
  const create: PlannedAction = plan([session("2026-10-02")])[0]!;
  const move: PlannedAction = plan([moved])[0]!;
  const remove: PlannedAction = plan([{ ...before, status: "skipped" }])[0]!;
  const result = (
    planned: PlannedAction,
    outcome: GarminWorkoutResult["outcome"],
    workoutId: number | null,
    scheduleId: number | null,
  ): GarminWorkoutResult => ({
    ref: planned.action.ref,
    action: planned.action.action,
    outcome,
    workoutId,
    scheduleId,
  });

  it("stores a create's ids, its workout's hash and its date", () => {
    expect(garminColumnsAfter(create, result(create, "done", 901, 801))).toEqual({
      garminWorkoutId: "901",
      garminScheduleId: "801",
      garminDate: "2026-10-02",
      garminHash: create.hash,
    });
  });

  it("keeps the workout of a create that uploaded but failed to schedule, with no date (Garmin outage)", () => {
    expect(garminColumnsAfter(create, result(create, "failed", 901, null))).toEqual({
      garminWorkoutId: "901",
      garminScheduleId: null,
      garminDate: null,
      garminHash: create.hash,
    });
  });

  it("stores nothing for a create that failed before uploading", () => {
    expect(garminColumnsAfter(create, result(create, "failed", null, null))).toEqual({
      garminWorkoutId: null,
      garminScheduleId: null,
      garminDate: null,
      garminHash: null,
    });
  });

  it("stores a move's new schedule and date and keeps the hash", () => {
    expect(garminColumnsAfter(move, result(move, "done", 900, 802))).toEqual({
      garminWorkoutId: "900",
      garminScheduleId: "802",
      garminDate: "2026-10-04",
      garminHash: before.garminHash,
    });
  });

  it("keeps the old date when a move failed before unscheduling, and drops it after", () => {
    expect(garminColumnsAfter(move, result(move, "failed", 900, 800))).toMatchObject({
      garminScheduleId: "800",
      garminDate: "2026-10-03",
    });
    expect(garminColumnsAfter(move, result(move, "failed", 900, null))).toEqual({
      garminWorkoutId: "900",
      garminScheduleId: null,
      garminDate: null,
      garminHash: before.garminHash,
    });
  });

  it("forgets everything after a remove, and keeps the workout when only its unschedule went through", () => {
    expect(garminColumnsAfter(remove, result(remove, "done", null, null))).toEqual({
      garminWorkoutId: null,
      garminScheduleId: null,
      garminDate: null,
      garminHash: null,
    });
    expect(garminColumnsAfter(remove, result(remove, "failed", 900, null))).toEqual({
      garminWorkoutId: "900",
      garminScheduleId: null,
      garminDate: null,
      garminHash: before.garminHash,
    });
  });

  it("forgets a workout Garmin no longer has, so it is created again (gone workout)", () => {
    expect(garminColumnsAfter(move, result(move, "gone", null, null))).toEqual({
      garminWorkoutId: null,
      garminScheduleId: null,
      garminDate: null,
      garminHash: null,
    });
  });

  it("changes nothing for an action never tried", () => {
    expect(garminColumnsAfter(move, result(move, "skipped", 900, 800))).toBeNull();
    expect(garminColumnsAfter(create, result(create, "skipped", null, null))).toBeNull();
  });
});
