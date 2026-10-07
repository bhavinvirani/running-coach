import {
  GPS_GLITCH_PACE_S_PER_KM,
  MAX_PLAN_WEEKS,
  METERS_PER_KM,
  type RaceDistanceKey,
  type SessionType,
  type StepKind,
} from "@running-coach/shared";

// Stored on each plan so a plan can be traced to the rule set that produced it.
export const ENGINE_VERSION = "0.5.0";

// The 10% rule: weekly running volume rises at most 10% over the previous week.
export const WEEKLY_VOLUME_MAX_INCREASE = 0.1;

// Glitch window, not a per-sample check: a real PR run stalled 4 s then caught up 25 m in 1 s and
// Garmin's records include it, while every real run measured stayed under 6.1 m/s over 10 s.
export const GLITCH_WINDOW_S = 10;

// Shared units.ts GPS_GLITCH_PACE_S_PER_KM as a speed (8.33 m/s): one definition of a glitch app-wide.
export const GPS_GLITCH_SPEED_M_PER_S = METERS_PER_KM / GPS_GLITCH_PACE_S_PER_KM;

// Bump when the best-efforts rule changes, so the API recomputes every stored best effort.
export const BEST_EFFORTS_VERSION = 1;

// Daniels and Gilbert, Oxygen Power (1979): VO2 = -4.60 + 0.182258 v + 0.000104 v^2, v in m/min.
export const VO2_COST = { intercept: -4.6, linear: 0.182258, quadratic: 0.000104 } as const;

// Daniels and Gilbert (1979): share of VO2max held for t minutes, 0.8 + a e^(-ka t) + b e^(-kb t).
export const VO2MAX_SHARE = {
  base: 0.8,
  a: 0.1894393,
  ka: 0.012778,
  b: 0.2989558,
  kb: 0.1932605,
} as const;

// Daniels' Running Formula intensities as shares of VDOT (E 59-74%, M 80-85%, T 86-88%, I 95-100%,
// R 105-110%), [slow end, fast end]; each band sits inside its intensity.
export const ZONE_VDOT_SHARES = {
  easy: [0.62, 0.72],
  marathon: [0.8, 0.84],
  threshold: [0.86, 0.9],
  interval: [0.96, 1.0],
  repetition: [1.04, 1.08],
} as const;

// Riegel, "Athletic records and human endurance" (1981): t2 = t1 (d2 / d1)^1.06.
export const RIEGEL_EXPONENT = 1.06;

// Riegel flatters recreational marathoners, who slow late; 5% slower is the usual correction.
export const MARATHON_PREDICTION_MARGIN = 0.05;

// Race pace band: the race pace +-1.5%, about +-5 s/km at 5:30/km.
export const RACE_PACE_BAND = 0.015;

// A target more than 5% faster than the prediction is a wish, not a pace to train at.
export const TARGET_TIME_AMBITIOUS_MARGIN = 0.05;

// SPEC "Plan engine": a plan covers at most 52 weeks. Defined in the shared contract, where the web
// form caps the race date with it; re-exported so the rules and the API read it from here.
export { MAX_PLAN_WEEKS };

// SPEC "Plan engine": minimum plan 8 weeks for 5K and 10K, 12 for the half, 18 for the marathon.
export const MIN_PLAN_WEEKS: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 8,
  "10k": 8,
  half: 12,
  marathon: 18,
};

// SPEC "Plan engine": taper 2 weeks, 3 for the marathon, as 7-day blocks counted back from the race.
export const TAPER_WEEKS: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 2,
  "10k": 2,
  half: 2,
  marathon: 3,
};

// The taper's blocks are 7 days counted back from race day, so the 7 days before any race are one.
export const TAPER_BLOCK_DAYS = 7;

// Daniels' phase IV: the 2 weeks before the taper carry the plan's peak work.
export const PEAK_PHASE_WEEKS = 2;

// A fitness plan is one 12-week block of base, build and peak, 4 weeks each, with no taper.
export const FITNESS_PLAN_WEEKS = 12;
export const FITNESS_PHASE_WEEKS = 4;

// The contract's planBaselineSchema: the volume of the 4 Monday-to-Sunday weeks before this week.
export const BASELINE_WEEKS = 4;

// SPEC "Plan engine": no run over 110% of the longest run of the last 30 days.
export const LONGEST_RUN_LOOKBACK_DAYS = 30;

// SPEC "Plan engine": paces from the VDOT of the best race in 180 days, else the best effort of 5K or
// more in 90 days. A race older than half a year, or a training best effort older than a quarter, no
// longer says what the runner can do.
export const RACE_LOOKBACK_DAYS = 180;
export const BEST_EFFORT_LOOKBACK_DAYS = 90;
// SPEC "Plan engine": only best efforts of 5K or more; shorter ones overstate endurance.
export const BEST_EFFORT_MIN_DISTANCE_M = 5000;

// SPEC re-entry: volume at 70% after 7 days off and 50% after 14.
export const RE_ENTRY_SHORT_BREAK_DAYS = 7;
export const RE_ENTRY_LONG_BREAK_DAYS = 14;
export const RE_ENTRY_SHORT_BREAK_FACTOR = 0.7;
export const RE_ENTRY_LONG_BREAK_FACTOR = 0.5;
// An empty baseline week right before the plan is a week off: one counts as 7 days, two as 14.
export const RE_ENTRY_DAYS_PER_EMPTY_WEEK = 7;

// First week of a runner with no recent runs, by distance: about 3 to 5 short runs. Only that runner
// starts here; a runner with history starts from their own volume (rules/baseline.ts).
export const START_VOLUME_FLOOR_M: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 15_000,
  "10k": 20_000,
  half: 25_000,
  marathon: 30_000,
};

// Typical recreational peak weeks by distance (Daniels' and Pfitzinger's lower-mileage plans).
export const PEAK_VOLUME_M: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 40_000,
  "10k": 48_000,
  half: 56_000,
  marathon: 72_000,
};

// Daniels: a recovery week every 4th week at about 80% of the volume around it.
export const DOWN_WEEK_EVERY = 4;
export const DOWN_WEEK_FACTOR = 0.8;

// SPEC taper cuts volume 40 to 60%, per 7-day block counted back from the race: the 7 days before it
// run 40% of the peak, the race excluded, the full 60% cut, so the legs are fresh on race day.
export const TAPER_FRACTIONS: Readonly<Record<number, readonly number[]>> = {
  2: [0.65, 0.4],
  3: [0.8, 0.6, 0.4],
};

// SPEC "Plan engine": long run at most 30% of weekly volume or 150 min. The share keeps the long run
// from growing past it; it does not shrink the longest run the runner already runs (long-run.ts).
export const LONG_RUN_SHARE = 0.3;
export const LONG_RUN_MAX_S = 9000;

// At 3 runs a week the longest is at least a third of the week, so 30% cannot hold; 40% leaves room.
export const LONG_RUN_SHARE_3_DAYS = 0.4;

// A taper block can hold fewer than 3 runs: the long run of n runs takes 1.2/n of them, the room 3 runs
// at 40% leave, so the runs still hold the block instead of shrinking it towards nothing.
// Source: this app's own choice; Daniels and the SPEC give no share under 3 runs, so 3 x 40% carries.
export const LONG_RUN_SHARE_FEW_RUNS = 1.2;

// SPEC "Plan engine": no run over 110% of the longest of the last 30 days (4 plan weeks).
export const LONGEST_RUN_MAX_INCREASE = 0.1;
export const LONGEST_RUN_LOOKBACK_WEEKS = 4;

// The longest run to grow from when the runner has none recent: a 5 km run.
// Source: this app's own choice: the shortest race it plans for, and room for a 20 min run beside it.
export const LONG_RUN_FLOOR_M = 5000;

// A marathon's 150 min long run beside two capped quality sessions is about 45% of a 3-run week.
export const MIN_DAYS_PER_WEEK: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 3,
  "10k": 3,
  half: 3,
  marathon: 4,
};

// Peak long run each distance asks for, in minutes at easy pace. Daniels caps the long run at the
// lesser of 25 to 30% of the week and 150 min, so at these peaks the usual ask is 2 h for the
// marathon and 90 min for the half.
export const REQUIRED_LONG_RUN_MIN: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 60,
  "10k": 75,
  half: 90,
  marathon: 120,
};

// SPEC "Plan engine": work per session at most T 10%, I 8%, R 5% of the week's distance; race pace as T.
export const WORK_CAP_SHARE = {
  threshold: 0.1,
  interval: 0.08,
  repetition: 0.05,
  race: 0.1,
} as const;

// A week with one quality session in base or build: tempo every other week, intervals and repetitions
// in turn between, so a 3-day runner meets all three of Daniels' T, I and R in every 4 weeks.
export const ONE_QUALITY_ROTATION = ["threshold", "interval", "threshold", "repetition"] as const;

// Daniels' menus, longest rep first: the longer rep when at least MIN_REPS_FOR_LONGER of it fit.
export const INTERVAL_REP_M: readonly [number, number] = [1000, 800];
export const REPETITION_REP_M: readonly [number, number] = [400, 200];
export const RACE_PRACTICE_REP_M: Readonly<Record<RaceDistanceKey, readonly [number, number]>> = {
  "5k": [1000, 400],
  "10k": [2000, 1000],
  half: [3000, 1000],
  marathon: [5000, 2000],
};
export const MIN_REPS_FOR_LONGER = 2;

// Daniels: T as one tempo block for 5K and 10K, cruise blocks for the longer races.
export const THRESHOLD_BLOCKS: Readonly<Record<RaceDistanceKey, number>> = {
  "5k": 1,
  "10k": 1,
  half: 2,
  marathon: 2,
};
// Threshold blocks are whole 100 m so the watch shows round distances.
// Source: Daniels' Running Formula sets T blocks by distance; the 100 m rounding is this app's own.
export const THRESHOLD_BLOCK_STEP_M = 100;

// Daniels' recoveries: 1 min per T block, about equal time after I reps, 2 min jog after R and race pace.
export const THRESHOLD_RECOVERY_S = 60;
export const INTERVAL_RECOVERY_S = 180;
export const REPETITION_RECOVERY_S = 120;
export const RACE_PRACTICE_RECOVERY_S = 120;

// Every quality session opens with 15 min and closes with 10 min easy.
// Source: Daniels' Running Formula, whose quality sessions start and end with E running.
export const WARMUP_S = 900;
export const COOLDOWN_S = 600;

// The shortest easy run worth lacing up for: 20 min.
// Source: this app's own choice: a shorter run is mostly the first minutes of a warmup.
export const MIN_RUN_S = 1200;

// Week 1's search tries every whole 100 m of week and the meter before it (rules/needed-volume.ts).
// Source: this app's own choice: work jumps at whole 100 m of week (T in 100 m blocks, reps by shares).
export const NEEDED_VOLUME_STEP_M = 100;

// SPEC "Plan engine": at least 80% of the week's time easy.
export const HARD_TIME_MAX_SHARE = 0.2;

// Race week: the race-pace session at least 3 days out; the day before the race is rest.
export const RACE_PRACTICE_MIN_DAYS_BEFORE_RACE = 3;

// SPEC "Plan engine": 48 h between hard days.
export const HARD_DAY_MIN_GAP_DAYS = 2;

// Daniels: the long run, quality sessions and races are the hard days the 48 h rule spaces; the plan
// generator lays them out by it and the API warns with it when a runner moves one.
export const HARD_SESSION_TYPES: ReadonlySet<SessionType> = new Set([
  "long",
  "intervals",
  "tempo",
  "race_practice",
  "race",
]);

// Garmin and Runna practice: warm-ups, jogs and cool-downs run by feel, so only run and work steps
// carry a pace target and the watch never alerts while the runner jogs.
export const TARGETED_STEP_KINDS: ReadonlySet<StepKind> = new Set(["run", "work"]);

// A fitness goal with no distance is shaped like a 10K: a middle ground of volume and speed work.
export const FITNESS_SHAPE_DISTANCE = "10k" satisfies RaceDistanceKey;

// Slice 9 plan (#9): the coach may cut a session to half or lengthen it by at most 10%, the 10% rule's
// step; the run and week caps can lower a rise further.
export const DELTA_MIN_FACTOR = 0.5;
export const DELTA_MAX_FACTOR = 1.1;

// A scaled step lands on whole 100 m or 10 s so the watch shows round numbers, as THRESHOLD_BLOCK_STEP_M.
export const SCALE_DISTANCE_STEP_M = 100;
export const SCALE_DURATION_STEP_S = 10;

// IEEE 754: 8000 x (8800 / 8000) can come out a hair under 8800; a nudge this small keeps the 100 m
// step from dropping a whole step, and moves no result by a millimetre.
export const FLOAT_TOLERANCE = 1e-9;

// SPEC re-entry: the first 7 days back hold no quality after 7+ days off or after illness or injury.
export const RE_ENTRY_EASY_DAYS = 7;

// SPEC walk-run return: 4 min run and 1 min walk, the first stage of the usual return-to-run ladder.
export const WALK_RUN_RUN_S = 240;
export const WALK_RUN_WALK_S = 60;
// The contract's repeat holds at least 2 rounds: a 10 min walk-run is the shortest.
export const WALK_RUN_MIN_REPEATS = 2;
// The engine's name for a walk-run session, shown instead of its type (planSessionSchema.title).
export const WALK_RUN_TITLE = "Walk-run";
