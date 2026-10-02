import type {
  GeneratedSession,
  GeneratedWeek,
  PlanPaces,
  PlanPhase,
  RaceDistanceKey,
  SessionSteps,
  Weekday,
} from "@running-coach/shared";
import { DISTANCE_METERS } from "@running-coach/shared";
import { addDays, daysBetween, weekdayIndex } from "../dates";
import { hardShareHolds, hardTimeS } from "../rules/easy-share";
import { weekLayout } from "../rules/hard-days";
import { longRunFloorM, longRunM } from "../rules/long-run";
import {
  dropRep,
  QUALITY_SESSION_TYPE,
  qualitySteps,
  qualityWork,
  qualityZones,
  workCapM,
  type Work,
  type WorkZone,
} from "../rules/quality";
import { raceWeekDays } from "../rules/race-week";
import { sessionTarget } from "../rules/session-target";
import { fillWeek } from "../rules/week-fill";

/** What every week of one plan shares. */
export interface PlanContext {
  /** The race distance, or the distance a fitness plan is shaped like. */
  distanceKey: RaceDistanceKey;
  daysPerWeek: number;
  longRunDay: Weekday;
  raceDate: string | null;
  paces: PlanPaces;
  /** The easy band's midpoint, the pace easy and long runs are planned at. */
  easyPaceSPerKm: number;
  minRunM: number;
  /** The baseline's longest run, which base, build and peak long runs keep; 0 with none. */
  baselineLongestM: number;
}

export interface BuiltWeek {
  week: GeneratedWeek;
  /** The long run this week's volume allowed, scheduled or not; the race week runs nothing longer. */
  longRunCapM: number;
  /** The scheduled long run, null in the race week or when its day is the day before the race. */
  longRunM: number | null;
  /** The longest run, the race excluded; 0 with none. */
  longestM: number;
  /** The last hard session's date, null with none. */
  lastHardDate: string | null;
}

export interface TrainingWeekInput {
  number: number;
  phase: PlanPhase;
  weekStart: string;
  targetM: number;
  /** 110% of the longest run of the last 4 weeks. */
  maxRunM: number;
  lastHardDate: string | null;
}

export interface RaceWeekInput {
  number: number;
  weekStart: string;
  /** The week's running, the race excluded. */
  targetM: number;
  /** No run this week passes last week's long run or 110% of the recent longest. */
  capM: number;
  lastHardDate: string | null;
}

interface Placed {
  date: string;
  work: Work;
}

const KEEPS_BASELINE_LONGEST: ReadonlySet<PlanPhase> = new Set(["base", "build", "peak"]);

const HARD_TYPES: ReadonlySet<GeneratedSession["type"]> = new Set([
  "long",
  "intervals",
  "tempo",
  "race_practice",
  "race",
]);

function runSession(
  date: string,
  type: "easy" | "long",
  distanceM: number,
  paces: PlanPaces,
): GeneratedSession {
  const steps: SessionSteps = [{ kind: "run", zone: "easy", distanceM, durationS: null }];
  return { date, type, target: sessionTarget(steps, paces), steps };
}

function qualitySession(placed: Placed, warmupPadM: number, paces: PlanPaces): GeneratedSession {
  const steps = qualitySteps({ work: placed.work, warmupPadM, paces });
  return {
    date: placed.date,
    type: QUALITY_SESSION_TYPE[placed.work.zone],
    target: sessionTarget(steps, paces),
    steps,
  };
}

function raceSession(
  date: string,
  distanceKey: RaceDistanceKey,
  paces: PlanPaces,
): GeneratedSession {
  // A half is 21097.5 m; the plan carries whole meters.
  const steps: SessionSteps = [
    {
      kind: "run",
      zone: "race",
      distanceM: Math.round(DISTANCE_METERS[distanceKey]),
      durationS: null,
    },
  ];
  return { date, type: "race", target: sessionTarget(steps, paces), steps };
}

function baseM(work: Work, paces: PlanPaces): number {
  return sessionTarget(qualitySteps({ work, warmupPadM: 0, paces }), paces).distanceM;
}

/** The work, less the reps the easy-share rule dropped, less any rep that makes the session too long. */
function sizedWork(
  ctx: PlanContext,
  zone: WorkZone,
  sizeM: number,
  drops: number,
  maxM: number,
): Work | null {
  let work = qualityWork({ zone, distanceKey: ctx.distanceKey, capM: workCapM(zone, sizeM) });
  for (let dropped = 0; dropped < drops && work !== null; dropped += 1) work = dropRep(work);
  while (work !== null && baseM(work, ctx.paces) > maxM) work = dropRep(work);
  return work;
}

const sumM = (sessions: readonly GeneratedSession[]) =>
  sessions.reduce((sum, session) => sum + session.target.distanceM, 0);

function hardIndexToDrop(placed: readonly Placed[], paces: PlanPaces): number {
  const hard = placed.map((p) =>
    hardTimeS(qualitySteps({ work: p.work, warmupPadM: 0, paces }), paces),
  );
  return hard.indexOf(Math.max(...hard));
}

function holdsEasyShare(sessions: readonly GeneratedSession[], paces: PlanPaces): boolean {
  return hardShareHolds({
    hardS: sessions.reduce((sum, session) => sum + hardTimeS(session.steps, paces), 0),
    totalS: sessions.reduce((sum, session) => sum + session.target.durationS, 0),
  });
}

function finish(
  number: number,
  phase: PlanPhase,
  weekStart: string,
  unsorted: GeneratedSession[],
): Omit<BuiltWeek, "longRunCapM" | "longRunM"> {
  const sessions = [...unsorted].sort((a, b) => daysBetween(b.date, a.date));
  const hard = sessions.filter((session) => HARD_TYPES.has(session.type));
  return {
    week: { number, startDate: weekStart, phase, distanceM: sumM(sessions), sessions },
    longestM: Math.max(
      0,
      ...sessions.filter((s) => s.type !== "race").map((s) => s.target.distanceM),
    ),
    lastHardDate: hard.at(-1)?.date ?? null,
  };
}

/**
 * A base, build, peak or taper week. The long run and quality sessions come first, then easy runs
 * fill the week's volume. Before the taper the long run never drops under the runner's own longest
 * (longRunFloorM). The long run and each session's work are measured against the week as built: a week
 * that holds less than its target shortens the long run to the longest the week holds, or sizes the
 * work from what it holds, and builds again; reps come off the hardest session while easy time is
 * under 80%. Each pass shortens the long run or the work or drops a rep, so the loop ends.
 */
export function buildTrainingWeek(ctx: PlanContext, input: TrainingWeekInput): BuiltWeek {
  const { number, phase, weekStart, targetM, maxRunM, lastHardDate } = input;
  const zones = qualityZones({ phase, weekNumber: number, daysPerWeek: ctx.daysPerWeek });
  const layout = weekLayout({
    longRunDay: ctx.longRunDay,
    daysPerWeek: ctx.daysPerWeek,
    qualityCount: zones.length,
    lastHardDaysBefore: lastHardDate === null ? null : daysBetween(lastHardDate, weekStart),
  });
  const dateOf = (day: Weekday) => addDays(weekStart, weekdayIndex(day));
  // Only the week before a Monday race holds the day before the race: its Sunday is rest, and a session
  // planned there moves to the latest free day as an easy run.
  const blocked = ctx.raceDate === null ? null : addDays(ctx.raceDate, -1);
  const longDate = dateOf(layout.longRun);
  const qualityDates = layout.quality.map(dateOf);
  const used = new Set([longDate, ...qualityDates, ...layout.easy.map(dateOf)]);
  const free = [6, 5, 4, 3, 2, 1, 0]
    .map((index) => addDays(weekStart, index))
    .filter((date) => !used.has(date) && date !== blocked);
  const movable = (date: string) => (date === blocked ? free.shift()! : date);
  const easyDates = layout.easy.map(dateOf).map(movable);
  const qualitySlotDates = qualityDates.map(movable);
  const hasLong = longDate !== blocked;

  // The long run a week of this volume allows: the share and its caps, and before the taper never
  // under the runner's own longest run.
  const longFor = (weekVolumeM: number) => {
    const sized = {
      weekVolumeM,
      daysPerWeek: ctx.daysPerWeek,
      easyPaceSPerKm: ctx.easyPaceSPerKm,
      maxRunM,
    };
    return KEEPS_BASELINE_LONGEST.has(phase)
      ? Math.max(
          longRunM(sized),
          longRunFloorM({ ...sized, baselineLongestM: ctx.baselineLongestM, minRunM: ctx.minRunM }),
        )
      : longRunM(sized);
  };

  let workSizeM = targetM;
  const drops = zones.map(() => 0);
  const build = (longM: number) => {
    const restM = targetM - (hasLong ? longM : 0);
    const quality = zones.map((zone, k): Placed | null => {
      if (qualityDates[k] === blocked) return null;
      const work = sizedWork(ctx, zone, workSizeM, drops[k]!, maxRunM);
      return work === null ? null : { date: qualityDates[k]!, work };
    });
    // The last session goes first while the long run and quality sessions alone pass the week.
    for (let k = quality.length - 1; k >= 0; k -= 1) {
      const qualityM = quality.reduce(
        (sum, p) => sum + (p === null ? 0 : baseM(p.work, ctx.paces)),
        0,
      );
      if (qualityM <= restM) break;
      quality[k] = null;
    }
    const placed = quality.filter((p): p is Placed => p !== null);
    const slots = [...easyDates, ...qualitySlotDates.filter((_, k) => quality[k] === null)];
    const fill = fillWeek({
      restM,
      capM: longM,
      qualityM: placed.map((p) => baseM(p.work, ctx.paces)),
      easySlots: slots.length,
      minRunM: ctx.minRunM,
    });
    const sessions = [
      ...(hasLong ? [runSession(longDate, "long", longM, ctx.paces)] : []),
      ...placed.map((p, k) => qualitySession(p, fill.qualityPadM[k]!, ctx.paces)),
      ...fill.easyRunsM.map((m, k) => runSession(slots[k]!, "easy", m, ctx.paces)),
    ];
    return { placed, sessions, actualM: sumM(sessions) };
  };
  const holds = (longM: number) => !hasLong || longM <= longFor(build(longM).actualM);
  // Between a long run the week as built allows and one it does not, the longest the week holds. A
  // week that cannot place its last few meters (the easy run would be under 20 min) gives those meters
  // up from the long run, rather than cutting the long run to its share of the shorter week.
  const longestHeldM = (allowedM: number, tooLongM: number) => {
    let low = allowedM;
    let high = tooLongM;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (holds(middle)) low = middle;
      else high = middle;
    }
    return low;
  };

  let longM = longFor(targetM);
  for (;;) {
    const { placed, sessions, actualM } = build(longM);
    if (hasLong && longM > longFor(actualM)) {
      longM = longestHeldM(longFor(actualM), longM);
      continue;
    }
    if (placed.some((p) => p.work.reps * p.work.repM > workCapM(p.work.zone, actualM))) {
      workSizeM = actualM;
      continue;
    }
    if (!holdsEasyShare(sessions, ctx.paces)) {
      drops[zones.indexOf(placed[hardIndexToDrop(placed, ctx.paces)]!.work.zone)]! += 1;
      continue;
    }
    return {
      ...finish(number, phase, weekStart, sessions),
      longRunCapM: longM,
      longRunM: hasLong ? longM : null,
    };
  }
}

/**
 * The race week: easy runs and one short race practice on the days before the day before the race,
 * then the race. Its running is sized like a training week's, without a long run.
 */
export function buildRaceWeek(ctx: PlanContext, input: RaceWeekInput): BuiltWeek {
  const { number, weekStart, targetM, capM, lastHardDate } = input;
  const raceDate = ctx.raceDate!;
  const days = raceWeekDays({
    weekStart,
    raceDate,
    longRunDay: ctx.longRunDay,
    daysPerWeek: ctx.daysPerWeek,
    lastHardDate,
  });
  let workSizeM = targetM;
  let drops = 0;
  for (;;) {
    const sized =
      days.racePracticeDate === null ? null : sizedWork(ctx, "race", workSizeM, drops, capM);
    const work = sized !== null && baseM(sized, ctx.paces) <= targetM ? sized : null;
    const practice = work === null ? null : { date: days.racePracticeDate!, work };
    const slots = [
      ...days.easyDates,
      ...(practice === null && days.racePracticeDate !== null ? [days.racePracticeDate] : []),
    ];
    const fill = fillWeek({
      restM: targetM,
      capM,
      qualityM: practice === null ? [] : [baseM(practice.work, ctx.paces)],
      easySlots: slots.length,
      minRunM: ctx.minRunM,
    });
    const running = [
      ...(practice === null ? [] : [qualitySession(practice, fill.qualityPadM[0]!, ctx.paces)]),
      ...fill.easyRunsM.map((m, k) => runSession(slots[k]!, "easy", m, ctx.paces)),
    ];
    const sessions = [...running, raceSession(raceDate, ctx.distanceKey, ctx.paces)];
    if (
      practice !== null &&
      practice.work.reps * practice.work.repM > workCapM("race", sumM(running))
    ) {
      workSizeM = sumM(running);
      continue;
    }
    if (!holdsEasyShare(sessions, ctx.paces)) {
      drops += 1;
      continue;
    }
    return { ...finish(number, "race", weekStart, sessions), longRunCapM: capM, longRunM: null };
  }
}
