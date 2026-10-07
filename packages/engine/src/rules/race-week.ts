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
  RUN_ROUND_M,
} from "../constants";
import { addDays, daysBetween, weekdayIndex, weekdayOf } from "../dates";
import { hardShareHolds, hardTimeS } from "./easy-share";
import { isSpacedFromHardDay } from "./hard-days";
import { qualitySteps, workCapM } from "./quality";
import { bandMidpointSPerKm, distanceForDurationM, sessionTarget } from "./session-target";
import { stridesM, withStrides } from "./strides";
import { isRaceBandWeek } from "./taper-share";
import { minRunDistanceM } from "./week-fill";

/**
 * practice: race practice. primer: 20 min easy and strides 2 days out. easy: an easy day of the 6 before
 * the race. extra: an easy day 7 to 9 days out in a Monday to Wednesday race's week before.
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
  daysPerWeek: number;
  /** The last hard day before the race week's days, as laid out; null with none. */
  lastHardDate: string | null;
  /**
   * The days the weeks before the race band lay out for themselves near the race: each counts towards
   * its calendar week's runs, and one in the 6 days before the race (a long run 6 days out) keeps its day.
   */
  laidOutDates: readonly string[];
}

export interface RaceWeekSessionsInput {
  /** From raceWeekDays, in pick order. */
  days: readonly RaceWeekDay[];
  distanceKey: RaceDistanceKey;
  paces: PlanPaces;
  /** No run over this: 110% of the recent longest. */
  maxRunM: number;
  /** The 6 days before the race run at most this, the race excluded: 40% of the taper peak. */
  windowCapM: number;
  /** What the days may run in each calendar week they fall in, by the week's Monday. */
  weekCapsM: Readonly<Record<string, number>>;
}

const mondayOf = (date: string) => addDays(date, -weekdayIndex(weekdayOf(date)));

/**
 * The race week's days, anchored on the days to the race wherever they fall, in the order a runner's
 * days fill them. The day before the race is rest. Race practice runs 4 days out, or 3 when 4 is under
 * 48 h after the last hard day, before the plan or in a week already full; none when both fail. Then the primer 2 days out and
 * easy days 5, 3 and 6 days out, up to the days asked for less the race. Every calendar week stays at the
 * days asked for, the days its own weeks lay out and the race counted. A Monday to Wednesday race's week
 * before is in the race band: its days 7 to 9 out add up to 2 easy runs, nearest the race first.
 */
export function raceWeekDays({
  raceDate,
  startDate,
  daysPerWeek,
  lastHardDate,
  laidOutDates,
}: RaceWeekDaysInput): RaceWeekDay[] {
  const dateAt = (daysOut: number) => addDays(raceDate, -daysOut);
  const runs = new Map<string, number>();
  const count = (date: string) => runs.set(mondayOf(date), (runs.get(mondayOf(date)) ?? 0) + 1);
  [...laidOutDates, raceDate].forEach(count);
  // A day runs from the plan's start, on no day the weeks before keep, in a week with a day to spare.
  const open = (daysOut: number) =>
    daysBetween(startDate, dateAt(daysOut)) >= 0 &&
    !laidOutDates.includes(dateAt(daysOut)) &&
    (runs.get(mondayOf(dateAt(daysOut))) ?? 0) < daysPerWeek;
  const practiceAt =
    [RACE_PRACTICE_DAYS_BEFORE_RACE, RACE_PRACTICE_MIN_DAYS_BEFORE_RACE].find(
      (daysOut) => open(daysOut) && isSpacedFromHardDay({ lastHardDate, date: dateAt(daysOut) }),
    ) ?? null;

  const days: RaceWeekDay[] = [];
  const take = (daysOut: number, kind: RaceWeekDayKind) => {
    days.push({ date: dateAt(daysOut), daysOut, kind });
    count(dateAt(daysOut));
  };
  const easyOrder = RACE_WEEK_DAY_ORDER.filter(
    (daysOut) => daysOut in RACE_WEEK_EASY_S && daysOut !== practiceAt,
  );
  for (const daysOut of [...(practiceAt === null ? [] : [practiceAt]), ...easyOrder]) {
    if (days.length === daysPerWeek - 1) break;
    if (!open(daysOut)) continue;
    const kind =
      daysOut === practiceAt
        ? "practice"
        : daysOut === RACE_WEEK_PRIMER_DAYS_OUT
          ? "primer"
          : "easy";
    take(daysOut, kind);
  }
  let extras = 0;
  for (const daysOut of RACE_BAND_EXTRA_DAY_ORDER) {
    if (
      extras < RACE_BAND_EXTRA_RUNS &&
      open(daysOut) &&
      isRaceBandWeek({ raceDate, weekStart: mondayOf(dateAt(daysOut)) })
    ) {
      take(daysOut, "extra");
      extras += 1;
    }
  }
  return days;
}

/** Whole 500 m under `targetM`, never under 20 min; the exact meters when no 500 m step fits. */
function roundedRunM(targetM: number, minRunM: number): number {
  const meters = Math.max(targetM, minRunM);
  const rounded = Math.floor(meters / RUN_ROUND_M) * RUN_ROUND_M;
  return rounded >= minRunM ? rounded : meters;
}

interface Planned {
  day: RaceWeekDay;
  /** An easy day's meters; the primer's before its strides; 0 for the practice. */
  lengthM: number;
}

/**
 * The race week's sessions on its days. Easy days are set by time at the easy midpoint (35 min 5 days
 * out, 30 min 3 and 6 days out, 30 min for an extra day), in whole 500 m, never under 20 min. Race practice
 * is a 15 min warm-up, reps at race pace with 2 min jogs (5K 4 x 400 m, 10K and half 3 x 1 km, marathon
 * 2 x 2 km) and a 10 min cool-down; the primer is 20 min easy and 4 strides. Then, until every rule holds:
 * no run over 110% of the recent longest (the practice loses reps, the primer its strides); race-pace work
 * at most 10% of the race week's km with the race; at least 80% easy over the 6 days before the race, the
 * race excluded on both sides, first dropping the primer's strides, then practice reps; and the 6 days
 * under 40% of the taper peak and each calendar week under its cap, first shortening easy days toward
 * 20 min in reverse pick order, then dropping days in reverse pick order. Every step only shrinks the
 * week, so the loop ends. A practice that loses its last rep rests its day.
 */
export function raceWeekSessions({
  days,
  distanceKey,
  paces,
  maxRunM,
  windowCapM,
  weekCapsM,
}: RaceWeekSessionsInput): GeneratedSession[] {
  const easyPaceSPerKm = bandMidpointSPerKm(paces.easy);
  const minRunM = minRunDistanceM(easyPaceSPerKm);
  const raceM = Math.round(DISTANCE_METERS[distanceKey]);
  const { repM } = RACE_WEEK_PRACTICE[distanceKey];
  const easyS = (day: RaceWeekDay) =>
    day.kind === "extra" ? RACE_BAND_EXTRA_S : RACE_WEEK_EASY_S[day.daysOut]!;
  let kept: Planned[] = days.map((day) => ({
    day,
    lengthM:
      day.kind === "practice"
        ? 0
        : Math.min(roundedRunM(distanceForDurationM(easyS(day), easyPaceSPerKm), minRunM), maxRunM),
  }));
  let reps = RACE_WEEK_PRACTICE[distanceKey].reps;
  let strides = true;
  const dropRep = () => {
    reps -= 1;
    if (reps === 0) kept = kept.filter((p) => p.day.kind !== "practice");
  };

  const sessionOf = ({ day, lengthM }: Planned): GeneratedSession => {
    if (day.kind === "practice") {
      const steps = qualitySteps({
        work: { zone: "race", repM, reps, recoveryS: RACE_PRACTICE_RECOVERY_S },
        warmupPadM: 0,
        paces,
      });
      return { date: day.date, type: "race_practice", target: sessionTarget(steps, paces), steps };
    }
    const steps: SessionSteps =
      day.kind === "primer" && strides
        ? withStrides({
            distanceM: lengthM + stridesM(RACE_WEEK_STRIDES, paces),
            count: RACE_WEEK_STRIDES,
            paces,
          })
        : [{ kind: "run", zone: "easy", distanceM: lengthM, durationS: null }];
    return { date: day.date, type: "easy", target: sessionTarget(steps, paces), steps };
  };

  for (;;) {
    const built = kept.map((planned) => ({ planned, session: sessionOf(planned) }));
    const meters = (of: readonly { session: GeneratedSession }[]) =>
      of.reduce((sum, { session }) => sum + session.target.distanceM, 0);
    const practice = built.find(({ planned }) => planned.day.kind === "practice");
    const primer = built.find(({ planned }) => planned.day.kind === "primer");
    const window = built.filter(({ planned }) => planned.day.kind !== "extra");

    if (practice !== undefined && practice.session.target.distanceM > maxRunM) {
      dropRep();
      continue;
    }
    if (strides && primer !== undefined && primer.session.target.distanceM > maxRunM) {
      strides = false;
      continue;
    }
    if (practice !== undefined && reps * repM > workCapM("race", meters(window) + raceM)) {
      dropRep();
      continue;
    }
    const holds = hardShareHolds({
      hardS: window.reduce((sum, { session }) => sum + hardTimeS(session.steps, paces), 0),
      totalS: window.reduce((sum, { session }) => sum + session.target.durationS, 0),
    });
    if (!holds) {
      // Hard time comes only from the primer's strides and the practice's reps.
      if (strides && primer !== undefined) strides = false;
      else dropRep();
      continue;
    }

    const over = [
      ...Object.entries(weekCapsM)
        .sort(([a], [b]) => daysBetween(b, a))
        .map(([weekStart, capM]) => ({
          capM,
          of: built.filter(({ planned }) => mondayOf(planned.day.date) === weekStart),
        })),
      { capM: windowCapM, of: window },
    ].find(({ capM, of }) => meters(of) > capM);
    if (over === undefined) {
      return built.map(({ session }) => session).sort((a, b) => daysBetween(b.date, a.date));
    }
    const shortenable = over.of
      .map(({ planned }) => planned)
      .filter((p) => (p.day.kind === "easy" || p.day.kind === "extra") && p.lengthM > minRunM)
      .reverse();
    if (shortenable.length === 0) {
      const last = over.of.at(-1)!.planned;
      kept = kept.filter((p) => p !== last);
      continue;
    }
    let left = meters(over.of) - over.capM;
    for (const p of shortenable) {
      if (left <= 0) break;
      const next = roundedRunM(p.lengthM - left, minRunM);
      left -= p.lengthM - next;
      p.lengthM = next;
    }
  }
}
