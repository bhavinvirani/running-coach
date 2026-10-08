import {
  DISTANCE_METERS,
  type GeneratedSession,
  type PlanPaces,
  type RaceDistanceKey,
  type SessionSteps,
} from "@running-coach/shared";
import {
  RACE_BAND_EXTRA_DAY_ORDER,
  RACE_BAND_EXTRA_RUNS,
  RACE_BAND_EXTRA_S,
  RACE_PRACTICE_DAYS_BEFORE_RACE,
  RACE_PRACTICE_MIN_DAYS_BEFORE_RACE,
  RACE_PRACTICE_RECOVERY_S,
  RACE_WEEK_DAY_ORDER,
  RACE_WEEK_EASY_S,
  RACE_WEEK_PRACTICE,
  RACE_WEEK_PRIMER_DAYS_OUT,
  RACE_WEEK_STRIDES,
} from "../constants";
import { addDays, daysBetween, mondayOf } from "../dates";
import { hardShareHolds, hardTimeS } from "./easy-share";
import { isSpacedFromHardDay } from "./hard-days";
import { qualitySteps, workCapM } from "./quality";
import { roundedRunM } from "./run-rounding";
import { bandMidpointSPerKm, distanceForDurationM, sessionTarget } from "./session-target";
import { stridesM, withStrides } from "./strides";
import { isRaceBandWeek } from "./taper-share";
import { minRunDistanceM } from "./week-fill";

/**
 * practice: race practice. primer: 20 min easy and strides 2 days out. easy: an easy day of the 6
 * before the race. extra: an easy day 7 to 9 days out in a Monday to Wednesday race's week before.
 */
export type RaceWeekDayKind = "practice" | "primer" | "easy" | "extra";

export interface RaceWeekDay {
  date: string;
  /** Days to the race. */
  daysOut: number;
  kind: RaceWeekDayKind;
}

export interface RaceWeekDaysInput {
  raceDate: string;
  /** The plan's first day: nothing runs before it. */
  startDate: string;
  /** Race practice moves off a week the race and the days laid out already fill. */
  daysPerWeek: number;
  /** The last hard day before the race week's days, as laid out; null with none. */
  lastHardDate: string | null;
  /**
   * The days the weeks before the race band lay out for themselves near the race: each counts
   * towards its calendar week's runs, and one in the 6 days before the race (a long run 6 days out)
   * keeps its day.
   */
  laidOutDates: readonly string[];
}

export interface RaceWeekSessionsInput {
  /** From raceWeekDays, in pick order. */
  days: readonly RaceWeekDay[];
  /** The days asked for: the 6 days before the race run one less, the race being a day. */
  daysPerWeek: number;
  /**
   * The race and the days the weeks before the race band lay out for themselves: each counts
   * towards its calendar week's runs.
   */
  takenDates: readonly string[];
  distanceKey: RaceDistanceKey;
  paces: PlanPaces;
  /** No run over this: 110% of the recent longest. */
  maxRunM: number;
  /**
   * No extra day over this either: the race-band week runs no long run, so its runs hold to its own
   * cap (the long run's cap by days, or 20 min where that is under it); maxRunM when not given.
   */
  extraMaxRunM?: number;
  /** The 6 days before the race run at most this, the race excluded: 40% of the taper peak. */
  windowCapM: number;
  /** What the days may run in each calendar week they fall in, by the week's Monday. */
  weekCapsM: Readonly<Record<string, number>>;
  /**
   * At most this many race-pace reps: what an earlier sizing of the same race week ran, so sizing
   * it again under a lower cap never adds one back (practiceReps).
   */
  maxReps?: number;
}

/** Each calendar week's runs among `dates`, by the week's Monday. */
function runsByWeek(dates: readonly string[]): Map<string, number> {
  const runs = new Map<string, number>();
  for (const date of dates) runs.set(mondayOf(date), (runs.get(mondayOf(date)) ?? 0) + 1);
  return runs;
}

/**
 * Every day the race week may run, anchored on the days to the race wherever they fall, in the
 * order a runner's days fill them; raceWeekSessions keeps those the days asked for and the caps
 * allow. The day before the race is rest, and no day runs before the plan's start or on a day the
 * weeks before keep. Race practice runs 4 days out, or 3 when 4 is under 48 h after the last hard
 * day, before the plan or in a week the race and the weeks before already fill; none when both
 * fail. Then the primer 2 days out and easy days 5, 3 and 6 days out. A Monday to Wednesday race's
 * week before is in the race band: its days 7, 9 and 8 out follow as extra easy days, nearest the
 * race first.
 */
export function raceWeekDays({
  raceDate,
  startDate,
  daysPerWeek,
  lastHardDate,
  laidOutDates,
}: RaceWeekDaysInput): RaceWeekDay[] {
  const dateAt = (daysOut: number) => addDays(raceDate, -daysOut);
  const runs = runsByWeek([...laidOutDates, raceDate]);
  // A day runs from the plan's start, on no day the weeks before keep.
  const open = (daysOut: number) =>
    daysBetween(startDate, dateAt(daysOut)) >= 0 && !laidOutDates.includes(dateAt(daysOut));
  const practiceAt =
    [RACE_PRACTICE_DAYS_BEFORE_RACE, RACE_PRACTICE_MIN_DAYS_BEFORE_RACE].find(
      (daysOut) =>
        open(daysOut) &&
        (runs.get(mondayOf(dateAt(daysOut))) ?? 0) < daysPerWeek &&
        isSpacedFromHardDay({ lastHardDate, date: dateAt(daysOut) }),
    ) ?? null;
  const day = (daysOut: number, kind: RaceWeekDayKind): RaceWeekDay => ({
    date: dateAt(daysOut),
    daysOut,
    kind,
  });
  return [
    ...(practiceAt === null ? [] : [day(practiceAt, "practice")]),
    ...RACE_WEEK_DAY_ORDER.filter(
      (daysOut) => daysOut in RACE_WEEK_EASY_S && daysOut !== practiceAt && open(daysOut),
    ).map((daysOut) => day(daysOut, daysOut === RACE_WEEK_PRIMER_DAYS_OUT ? "primer" : "easy")),
    ...RACE_BAND_EXTRA_DAY_ORDER.filter(
      (daysOut) =>
        open(daysOut) && isRaceBandWeek({ raceDate, weekStart: mondayOf(dateAt(daysOut)) }),
    ).map((daysOut) => day(daysOut, "extra")),
  ];
}

/**
 * What the race week's sessions run at their shortest: easy days shorten to 20 min (one under it
 * stays as it is), race practice and a primer with its strides as they are. A week the race week's
 * days share holds a 20 min run of its own beside them while its ceiling passes this by 20 min.
 */
export function raceWeekShortestM(sessions: readonly GeneratedSession[], minRunM: number): number {
  return sessions.reduce(
    (sum, s) =>
      sum +
      (s.type === "easy" && s.steps.every((item) => !("repeat" in item))
        ? Math.min(s.target.distanceM, minRunM)
        : s.target.distanceM),
    0,
  );
}

/** The race-pace reps of the race week's practice; null with none. */
export function practiceReps(sessions: readonly GeneratedSession[]): number | null {
  const practice = sessions.find((s) => s.type === "race_practice");
  if (practice === undefined) return null;
  return practice.steps.reduce(
    (sum, item) =>
      sum +
      ("repeat" in item
        ? item.repeat * item.steps.filter((step) => step.kind === "work").length
        : item.kind === "work"
          ? 1
          : 0),
    0,
  );
}

/** Whole 500 m under `targetM`, never under 20 min; the exact meters when no 500 m step fits. */
const roundedDayM = (targetM: number, minRunM: number) =>
  roundedRunM(Math.max(targetM, minRunM), minRunM);

interface Planned {
  day: RaceWeekDay;
  /** An easy day's meters; the primer's before its strides; 0 for the practice. */
  lengthM: number;
  /** A primer that runs without its strides, which passed a cap. */
  plain?: boolean;
}

/**
 * The race week's sessions on its days. Easy days are set by time at the easy midpoint (35 min 5
 * days out, 30 min 3 and 6 days out, 30 min for an extra day), in whole 500 m, never under 20 min.
 * Race practice is a 15 min warm-up, reps at race pace with 2 min jogs (5K 4 x 400 m, 10K and half
 * 3 x 1 km, marathon 2 x 2 km, never more than maxReps) and a 10 min cool-down; the primer is 20
 * min easy and 4 strides. No run passes 110% of the recent longest: the practice loses reps, the
 * primer its strides; no extra day passes its week's own cap either (extraMaxRunM). Then the days
 * are added in pick order while the 6 days run at most the days asked for less the race, the extra
 * days at most 2, each calendar week at most the days asked for (the race and the days the weeks
 * before keep counted), the 6 days at most 40% of the taper peak and each calendar week its cap: a
 * day that passes a cap first shortens the easy days toward 20 min, itself first, then the others in
 * reverse pick order, and rests when that is not enough, the others keeping their length; the
 * primer, beside no easy day yet, runs without its strides before it rests. The days after it are
 * still tried. Race-pace work stays within 10% of the race week's km with the race, and the 6 days, the
 * race excluded on both sides, stay 80% easy: while either fails, the primer's strides go first
 * (for the 80% rule), then a practice rep, and the days are added again from the start, so a
 * practice with no rep left rests its day before any other day gives way to it.
 */
export function raceWeekSessions({
  days,
  daysPerWeek,
  takenDates,
  distanceKey,
  paces,
  maxRunM,
  extraMaxRunM = maxRunM,
  windowCapM,
  weekCapsM,
  maxReps = Infinity,
}: RaceWeekSessionsInput): GeneratedSession[] {
  const easyPaceSPerKm = bandMidpointSPerKm(paces.easy);
  const minRunM = minRunDistanceM(easyPaceSPerKm);
  const raceM = Math.round(DISTANCE_METERS[distanceKey]);
  const { repM } = RACE_WEEK_PRACTICE[distanceKey];
  const easyDayM = (seconds: number, capM = maxRunM) =>
    Math.min(roundedDayM(distanceForDurationM(seconds, easyPaceSPerKm), minRunM), capM);
  const easyLengthM = (day: RaceWeekDay) =>
    day.kind === "extra"
      ? easyDayM(RACE_BAND_EXTRA_S, Math.min(maxRunM, extraMaxRunM))
      : easyDayM(RACE_WEEK_EASY_S[day.daysOut]!);
  const practiceSteps = (reps: number) =>
    qualitySteps({
      work: { zone: "race", repM, reps, recoveryS: RACE_PRACTICE_RECOVERY_S },
      warmupPadM: 0,
      cooldownPadM: 0,
      paces,
    });
  const primerM = easyDayM(RACE_WEEK_EASY_S[RACE_WEEK_PRIMER_DAYS_OUT]!);

  // The run cap holds whatever else runs: it sets the practice's reps and the primer's strides
  // first.
  let reps = Math.min(RACE_WEEK_PRACTICE[distanceKey].reps, maxReps);
  while (reps > 0 && sessionTarget(practiceSteps(reps), paces).distanceM > maxRunM) reps -= 1;
  let strides = primerM + stridesM(RACE_WEEK_STRIDES, paces) <= maxRunM;

  const sessionOf = (p: Planned): GeneratedSession => {
    const { day, lengthM } = p;
    if (day.kind === "practice") {
      const steps = practiceSteps(reps);
      return { date: day.date, type: "race_practice", target: sessionTarget(steps, paces), steps };
    }
    const steps: SessionSteps =
      day.kind === "primer" && strides && p.plain !== true
        ? withStrides({
            distanceM: lengthM + stridesM(RACE_WEEK_STRIDES, paces),
            count: RACE_WEEK_STRIDES,
            paces,
          })
        : [{ kind: "run", zone: "easy", distanceM: lengthM, durationS: null }];
    return { date: day.date, type: "easy", target: sessionTarget(steps, paces), steps };
  };
  const meters = (planned: readonly Planned[]) =>
    planned.reduce((sum, p) => sum + sessionOf(p).target.distanceM, 0);
  const inWindow = (planned: readonly Planned[]) => planned.filter((p) => p.day.kind !== "extra");
  // Each calendar week in date order, then the 6 days before the race.
  const caps = (planned: readonly Planned[]) => [
    ...Object.entries(weekCapsM)
      .sort(([a], [b]) => daysBetween(b, a))
      .map(([weekStart, capM]) => ({
        capM,
        of: planned.filter((p) => mondayOf(p.day.date) === weekStart),
      })),
    { capM: windowCapM, of: inWindow(planned) },
  ];
  // The days with one more, its easy days shortened toward 20 min until every cap holds, the new
  // day first and then the others in reverse pick order, and a new primer without its strides;
  // null when even 20 min on each passes a cap.
  const withDay = (kept: readonly Planned[], day: RaceWeekDay): Planned[] | null => {
    const planned = [
      ...kept.map((p) => ({ ...p })),
      { day, lengthM: day.kind === "practice" ? 0 : easyLengthM(day) },
    ];
    for (;;) {
      const over = caps(planned).find(({ capM, of }) => meters(of) > capM);
      if (over === undefined) return planned;
      const shortenable = over.of
        .filter((p) => (p.day.kind === "easy" || p.day.kind === "extra") && p.lengthM > minRunM)
        .reverse();
      if (shortenable.length === 0) {
        // Picked right after the practice, the primer has no easy day beside it to shorten.
        const added = planned.at(-1)!;
        if (added.day.kind !== "primer" || added.plain === true || !strides) return null;
        added.plain = true;
        continue;
      }
      let left = meters(over.of) - over.capM;
      for (const p of shortenable) {
        if (left <= 0) break;
        const next = roundedDayM(p.lengthM - left, minRunM);
        left -= p.lengthM - next;
        p.lengthM = next;
      }
    }
  };

  const taken = runsByWeek(takenDates);
  // Room for the day among the days asked for: the 6 days less the race, 2 extra days, and each
  // calendar week with the race and the days the weeks before keep counted.
  const hasRoom = (kept: readonly Planned[], day: RaceWeekDay) => {
    const extra = day.kind === "extra";
    const weekStart = mondayOf(day.date);
    return (
      kept.filter((p) => (p.day.kind === "extra") === extra).length <
        (extra ? RACE_BAND_EXTRA_RUNS : daysPerWeek - 1) &&
      (taken.get(weekStart) ?? 0) + kept.filter((p) => mondayOf(p.day.date) === weekStart).length <
        daysPerWeek
    );
  };

  for (;;) {
    let kept: Planned[] = [];
    for (const day of days) {
      if ((day.kind === "practice" && reps === 0) || !hasRoom(kept, day)) continue;
      kept = withDay(kept, day) ?? kept;
    }
    const window = inWindow(kept).map(sessionOf);
    const practice = kept.some((p) => p.day.kind === "practice");
    if (practice && reps * repM > workCapM("race", meters(inWindow(kept)) + raceM)) {
      reps -= 1;
      continue;
    }
    const holds = hardShareHolds({
      hardS: window.reduce((sum, session) => sum + hardTimeS(session.steps, paces), 0),
      totalS: window.reduce((sum, session) => sum + session.target.durationS, 0),
    });
    if (!holds) {
      // Hard time comes only from the primer's strides and the practice's reps.
      if (strides && kept.some((p) => p.day.kind === "primer" && p.plain !== true)) strides = false;
      else reps -= 1;
      continue;
    }
    return kept.map(sessionOf).sort((a, b) => daysBetween(b.date, a.date));
  }
}
