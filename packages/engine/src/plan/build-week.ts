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
import { EASY_RUN_STRIDES, HARD_SESSION_TYPES } from "../constants";
import { addDays, daysBetween, weekdayIndex, weekdayOf } from "../dates";
import { hardShareHolds, hardTimeS } from "../rules/easy-share";
import { fastFinishM, longRunSteps, shorterFinishM } from "../rules/fast-finish";
import { weekLayout } from "../rules/hard-days";
import {
  longRunFloorM,
  longRunGivingWayM,
  longRunHoldsQuality,
  longRunM,
  longRunRoomM,
} from "../rules/long-run";
import {
  dropRep,
  QUALITY_SESSION_TYPE,
  QUALITY_SESSION_TYPES,
  qualitySteps,
  qualityWork,
  qualityZones,
  workCapM,
  type Work,
  type WorkZone,
} from "../rules/quality";
import { sessionTarget } from "../rules/session-target";
import { stridesRunIndex, withStrides } from "../rules/strides";
import { fillWeek, type QualityPad } from "../rules/week-fill";

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

/** A quality session's day and the zone of its work. */
export interface QualitySlot {
  date: string;
  zone: WorkZone;
}

/** The days a week runs and what each holds; a day not named is rest. */
export interface Slots {
  long: string | null;
  quality: QualitySlot[];
  /** In fill order: the first easy run goes on the first day. */
  easy: string[];
}

export interface WeekSlotsInput {
  number: number;
  phase: PlanPhase;
  weekStart: string;
  lastHardDate: string | null;
}

export interface TrainingWeekInput extends WeekSlotsInput {
  targetM: number;
  /**
   * No run over this: 110% of the longest run of the last 4 weeks and, in a race plan, the long
   * run's cap by days to the race (weekRunCaps).
   */
  maxRunM: number;
  /**
   * False where the long run's cap by days to the race is under 20 min: its day runs easy, and no
   * run passes 20 min (maxRunM).
   */
  longRun?: boolean;
  /** The long run ends at marathon pace (fast-finish.ts fastFinishWeeks). */
  fastFinish: boolean;
}

export interface SizeWeekInput {
  slots: Slots;
  /**
   * Sessions already in the week, sized elsewhere (the race week's days in the week before it): they
   * count towards its volume, its shares and its easy time, and a fixed long run caps the others.
   */
  fixed?: readonly GeneratedSession[];
  /** Base, build and peak long runs never drop under the runner's own longest run. */
  keepsBaselineLongest: boolean;
  /** The week's volume, the fixed sessions included. */
  targetM: number;
  /**
   * No run over this: 110% of the longest run of the last 4 weeks and, in a race plan, the long
   * run's cap by days to the race (weekRunCaps).
   */
  maxRunM: number;
  /** The week's number: tempo blocks and the order of the easy shares follow it. */
  weekNumber: number;
  /** The long run ends at marathon pace. */
  fastFinish: boolean;
}

export interface FinishedWeek {
  week: GeneratedWeek;
  /** The longest run, the race excluded; 0 with none. */
  longestM: number;
  /** The last hard session's date, null with none. */
  lastHardDate: string | null;
}

export interface BuiltWeek extends FinishedWeek {
  /** The days the week was laid out on, before sizing gave any of them up. */
  slots: Slots;
}

interface Placed {
  date: string;
  work: Work;
  /** Its quality slot, whose dropped reps it carries. */
  slot: number;
}

const KEEPS_BASELINE_LONGEST: ReadonlySet<PlanPhase> = new Set(["base", "build", "peak"]);

export const sumM = (sessions: readonly GeneratedSession[]) =>
  sessions.reduce((sum, session) => sum + session.target.distanceM, 0);

function runSession(
  date: string,
  type: "easy" | "long",
  steps: SessionSteps,
  paces: PlanPaces,
): GeneratedSession {
  return { date, type, target: sessionTarget(steps, paces), steps };
}

function qualitySession(placed: Placed, pad: QualityPad, paces: PlanPaces): GeneratedSession {
  const steps = qualitySteps({
    work: placed.work,
    warmupPadM: pad.warmupM,
    cooldownPadM: pad.cooldownM,
    paces,
  });
  return {
    date: placed.date,
    type: QUALITY_SESSION_TYPE[placed.work.zone],
    target: sessionTarget(steps, paces),
    steps,
  };
}

export function raceSession(
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
  return sessionTarget(qualitySteps({ work, warmupPadM: 0, cooldownPadM: 0, paces }), paces)
    .distanceM;
}

/** The work, less the reps the easy-share rule dropped, less any rep that makes the session too long. */
function sizedWork(
  ctx: PlanContext,
  zone: WorkZone,
  {
    sizeM,
    drops,
    maxM,
    weekNumber,
  }: { sizeM: number; drops: number; maxM: number; weekNumber: number },
): Work | null {
  let work = qualityWork({
    zone,
    distanceKey: ctx.distanceKey,
    capM: workCapM(zone, sizeM),
    weekNumber,
    paces: ctx.paces,
  });
  for (let dropped = 0; dropped < drops && work !== null; dropped += 1) work = dropRep(work);
  while (work !== null && baseM(work, ctx.paces) > maxM) work = dropRep(work);
  return work;
}

function hardIndexToDrop(placed: readonly Placed[], paces: PlanPaces): number {
  const hard = placed.map((p) =>
    hardTimeS(qualitySteps({ work: p.work, warmupPadM: 0, cooldownPadM: 0, paces }), paces),
  );
  return hard.indexOf(Math.max(...hard));
}

function holdsEasyShare(sessions: readonly GeneratedSession[], paces: PlanPaces): boolean {
  return hardShareHolds({
    hardS: sessions.reduce((sum, session) => sum + hardTimeS(session.steps, paces), 0),
    totalS: sessions.reduce((sum, session) => sum + session.target.durationS, 0),
  });
}

/** A week's sessions in date order, their total and what the weeks after it measure from it. */
export function finishWeek(
  number: number,
  phase: PlanPhase,
  weekStart: string,
  unsorted: readonly GeneratedSession[],
): FinishedWeek {
  const sessions = [...unsorted].sort((a, b) => daysBetween(b.date, a.date));
  const hard = sessions.filter((session) => HARD_SESSION_TYPES.has(session.type));
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
 * Which day of a Monday-to-Sunday week holds the long run, each quality session and each easy run. The
 * race week's days and the day before the race are the race week's template (build-taper.ts), so no
 * week laid out here holds them.
 */
export function weekSlots(ctx: PlanContext, input: WeekSlotsInput): Slots {
  const { number, phase, weekStart, lastHardDate } = input;
  const zones = qualityZones({ phase, weekNumber: number, daysPerWeek: ctx.daysPerWeek });
  const layout = weekLayout({
    longRunDay: ctx.longRunDay,
    daysPerWeek: ctx.daysPerWeek,
    qualityCount: zones.length,
    lastHardDaysBefore: lastHardDate === null ? null : daysBetween(lastHardDate, weekStart),
  });
  const dateOf = (day: Weekday) => addDays(weekStart, weekdayIndex(day));
  return {
    long: dateOf(layout.longRun),
    quality: zones.map((zone, k) => ({ date: dateOf(layout.quality[k]!), zone })),
    easy: layout.easy.map(dateOf),
  };
}

/**
 * The sessions on a week's slots, for its target volume. The long run and quality sessions come
 * first, then easy runs fill the volume. Base, build and peak long runs never drop under the
 * runner's own longest (longRunFloorM), but every day comes first: the long run gives way down to
 * 20 min (longRunGivingWayM), then the last quality session gives its day to an easy run, so a 20
 * min run fits on every day the volume allows. The long run stays the longest run: a second quality
 * session it would be shorter than runs easy, a lone one loses reps. The long run and each
 * session's work are measured against the sessions as built: when they hold less than the target,
 * the long run shortens to the longest they hold, or the work is sized from what they hold and the
 * long run again, and they are built again. Easy runs take unequal shares of at most 85% of the
 * long run (week-fill.ts); what they cannot hold pads the quality sessions' warm-ups and cool-downs
 * up to 25 min each, and the rest is not run, so a week can hold less than its target. A finish
 * week's long run ends at marathon pace, and a week of at most 1 quality session carries strides on
 * one easy run, both carved out of their runs. While easy time is under 80%, the finish shortens
 * 500 m at a time, then the strides go, then reps come off the hardest session. Each pass shortens
 * the long run, or shrinks the work, the finish or the strides, which only shrink, so the loop
 * ends. Slots with no long run still size one: the long run their volume allows caps every other
 * run. The long run's share follows the days that run (longRunShare), so a taper week of fewer runs
 * than the runner's days holds its volume. The long run takes at most what the target leaves after
 * the fixed sessions, and beside them runs not at all where that is under 20 min, so the week stays
 * under its target. A taper week runs fewer, longer runs rather than runs under 20 min: the days
 * its easy runs leave empty give up their slots, so the long run's room and share follow the days
 * that run, and while an easy or long run is under 20 min it gives up its last day in fill order,
 * then its last quality day. Each time it is sized again, until no run is under 20 min or only the
 * long run is left, at what the week holds; every pass drops a day, so the loop ends.
 */
export function sizeWeek(ctx: PlanContext, input: SizeWeekInput): GeneratedSession[] {
  let { slots } = input;
  const without = (dates: readonly string[]): Slots => ({
    ...slots,
    quality: slots.quality.filter((slot) => !dates.includes(slot.date)),
    easy: slots.easy.filter((date) => !dates.includes(date)),
  });
  for (;;) {
    const { sessions, fillDates } = sizeSlots(ctx, { ...input, slots });
    if (input.keepsBaselineLongest) return sessions;
    const unused = fillDates.slice(sessions.filter((session) => session.type === "easy").length);
    const short = sessions.some(
      (session) =>
        (session.type === "long" || session.type === "easy") &&
        session.target.distanceM < ctx.minRunM,
    );
    const lastDay = fillDates.at(-1) ?? slots.quality.at(-1)?.date;
    if (unused.length > 0) slots = without(unused);
    else if (short && lastDay !== undefined) slots = without([lastDay]);
    else return sessions;
  }
}

/**
 * One sizing of the slots as given (sizeWeek), and the days the easy runs fill in order: the easy
 * days, then the quality days that run easy; the runs take the first of them.
 */
function sizeSlots(
  ctx: PlanContext,
  {
    slots,
    fixed = [],
    keepsBaselineLongest,
    targetM,
    maxRunM,
    weekNumber,
    fastFinish,
  }: SizeWeekInput,
): { sessions: GeneratedSession[]; fillDates: string[] } {
  const zones = slots.quality.map((slot) => slot.zone);
  const fixedM = sumM(fixed);
  const fixedLongM = fixed.find((session) => session.type === "long")?.target.distanceM ?? null;
  // What the target leaves the slots once the fixed sessions are in: the long run's most, and
  // beside fixed sessions no long run at all where that is under 20 min.
  const leftM = targetM - fixedM + (fixedLongM ?? 0);
  const hasLong = slots.long !== null && (fixed.length === 0 || leftM >= ctx.minRunM);
  // Days that run here, the long run's included. Without a long run an easy day stands in for it, so
  // the room is measured alike; the other fixed sessions take their meters, not room.
  const days = Math.max(
    slots.easy.length + zones.length + (hasLong || fixedLongM !== null ? 1 : 0),
    zones.length + 1,
  );
  const runs = days + fixed.filter((session) => session.type !== "long").length;
  // What the slots and a fixed long run hold of the week's volume; the other fixed sessions spent it.
  const freeM = (weekVolumeM: number) => weekVolumeM - fixedM + (fixedLongM ?? 0);

  let workSizeM = targetM;
  const drops = zones.map(() => 0);
  const roomIn = (weekVolumeM: number, qualityM: readonly number[]) =>
    longRunRoomM({
      weekVolumeM: freeM(weekVolumeM),
      daysPerWeek: days,
      minRunM: ctx.minRunM,
      qualityM,
    });
  const sizesOf = (quality: readonly (Placed | null)[]) =>
    quality.filter((p): p is Placed => p !== null).map((p) => baseM(p.work, ctx.paces));
  // The quality sessions and the long run a week of this volume holds, as sized now; null for a session
  // with no work. The long run takes the share and its caps, before the taper never under the runner's
  // own longest run, and gives way to the room the quality sessions and 20 min on every easy day leave,
  // though never under 20 min; a fixed long run is what it is. A day comes first, and the long run
  // stays the longest run: the last session runs easy instead while the room is short or a second
  // session passes the long run, and a lone session that passes it loses reps.
  const shapeFor = (weekVolumeM: number) => {
    const sized = { weekVolumeM, daysPerWeek: runs, easyPaceSPerKm: ctx.easyPaceSPerKm, maxRunM };
    const quality = zones.map((zone, k): Placed | null => {
      const work = sizedWork(ctx, zone, {
        sizeM: workSizeM,
        drops: drops[k]!,
        maxM: maxRunM,
        weekNumber,
      });
      return work === null ? null : { date: slots.quality[k]!.date, work, slot: k };
    });
    for (;;) {
      const qualityM = sizesOf(quality);
      const roomM = roomIn(weekVolumeM, qualityM);
      const capM = keepsBaselineLongest
        ? Math.max(
            longRunM(sized),
            longRunFloorM({
              ...sized,
              weekVolumeM: freeM(weekVolumeM),
              daysPerWeek: days,
              baselineLongestM: ctx.baselineLongestM,
              minRunM: ctx.minRunM,
              qualityM,
            }),
          )
        : longRunM(sized);
      const longM =
        fixedLongM ??
        Math.min(longRunGivingWayM({ longM: capM, roomM, minRunM: ctx.minRunM }), leftM);
      const fits = roomM >= (fixedLongM ?? ctx.minRunM);
      const last = quality.findLastIndex((p) => p !== null);
      if (last === -1 || (fits && longRunHoldsQuality({ longM, qualityM }))) {
        return { quality, longM };
      }
      const lone = quality.at(last)!;
      if (qualityM.length > 1 || !fits) {
        quality[last] = null;
      } else {
        const work = dropRep(lone.work);
        quality[last] = work === null ? null : { ...lone, work };
      }
    }
  };
  // The shape a volume gives depends on the work sized so far and the reps dropped; builds ask for the
  // same ones again and again.
  const shapes = new Map<string, ReturnType<typeof shapeFor>>();
  const shapeOf = (weekVolumeM: number) => {
    const key = `${weekVolumeM}:${workSizeM}:${drops.join(",")}`;
    const known = shapes.get(key);
    if (known !== undefined) return known;
    const shape = shapeFor(weekVolumeM);
    shapes.set(key, shape);
    return shape;
  };
  const longFor = (weekVolumeM: number) => shapeOf(weekVolumeM).longM;

  // Easy shares and strides look at the weekday after the long run's, whether this week runs one or not.
  const afterLongDay = (weekdayIndex(ctx.longRunDay) + 1) % 7;
  const weekdays = new Map(
    [...slots.easy, ...slots.quality.map((slot) => slot.date)].map((date) => [
      date,
      weekdayIndex(weekdayOf(date)),
    ]),
  );
  const dayOf = (date: string) => weekdays.get(date)!;
  const fixedQuality = fixed.filter((session) => QUALITY_SESSION_TYPES.has(session.type)).length;
  // The extras the easy-time rule takes off first: the finish 500 m at a time, then the strides.
  let finishCuts = 0;
  let strides = true;
  const finishFor = (longM: number) => {
    let finishM = fastFinish ? fastFinishM(longM) : 0;
    for (let cut = 0; cut < finishCuts; cut += 1) finishM = shorterFinishM(finishM);
    return finishM;
  };

  const builtFor = (longM: number) => {
    const restM = targetM - fixedM - (hasLong ? longM : 0);
    const { quality } = shapeOf(targetM);
    const placed = quality.filter((p): p is Placed => p !== null);
    const fillSlots = [
      ...slots.easy,
      ...slots.quality.filter((_, k) => quality[k] === null).map((slot) => slot.date),
    ];
    const fill = fillWeek({
      restM,
      longM,
      qualityM: placed.map((p) => baseM(p.work, ctx.paces)),
      easyDays: fillSlots.map(dayOf),
      afterLongDay,
      weekNumber,
      minRunM: ctx.minRunM,
      easyPaceSPerKm: ctx.easyPaceSPerKm,
      // Weeks before the taper run every day asked for; a taper week may run fewer.
      keepDays: keepsBaselineLongest,
    });
    const finishM = hasLong ? finishFor(longM) : 0;
    const stridesAt = strides
      ? stridesRunIndex({
          runs: fill.easyRunsM.map((distanceM, k) => ({ day: dayOf(fillSlots[k]!), distanceM })),
          afterLongDay,
          qualityCount: placed.length + fixedQuality,
          paces: ctx.paces,
        })
      : null;
    const easySteps = (distanceM: number, k: number): SessionSteps =>
      k === stridesAt
        ? withStrides({ distanceM, count: EASY_RUN_STRIDES, paces: ctx.paces })
        : [{ kind: "run", zone: "easy", distanceM, durationS: null }];
    const sessions = [
      ...(hasLong
        ? [runSession(slots.long!, "long", longRunSteps({ distanceM: longM, finishM }), ctx.paces)]
        : []),
      ...placed.map((p, k) => qualitySession(p, fill.qualityPadM[k]!, ctx.paces)),
      ...fill.easyRunsM.map((m, k) =>
        runSession(fillSlots[k]!, "easy", easySteps(m, k), ctx.paces),
      ),
    ];
    return {
      placed,
      sessions,
      actualM: sumM(sessions) + fixedM,
      finishM,
      stridesAt,
      fillDates: fillSlots,
    };
  };
  // The searches build the same long run more than once before anything else changes: the week built
  // for each, until the work, the reps, the finish or the strides change.
  let built = new Map<number, ReturnType<typeof builtFor>>();
  let builtState = "";
  const build = (longM: number) => {
    const state = `${workSizeM}:${drops.join(",")}:${finishCuts}:${strides}`;
    if (state !== builtState) {
      built = new Map();
      builtState = state;
    }
    const known = built.get(longM);
    if (known !== undefined) return known;
    const week = builtFor(longM);
    built.set(longM, week);
    return week;
  };
  // How far a long run of `longM` is under the long run the week built around it allows (its share of
  // that week): it holds while that is not negative. Easy runs are capped at 85% of the long run, so a
  // shorter long run can shrink the week as built too; the slack changes almost linearly with the long
  // run, and the long runs that hold are those up to a boundary.
  const slackM = (longM: number) => longFor(build(longM).actualM) - longM;
  // Between a long run that holds and a longer one that does not, the longest that holds: each try aims
  // where the line through the two ends crosses zero, and halves the range when one end has moved twice
  // in a row, so a kink in the slack cannot slow the search.
  function boundaryM(heldM: number, heldSlackM: number, notHeldM: number, notHeldSlackM: number) {
    let low = heldM;
    let lowSlackM = heldSlackM;
    let high = notHeldM;
    let highSlackM = notHeldSlackM;
    let lastHeld: boolean | null = null;
    let streak = 0;
    while (high - low > 1) {
      const aimedM = low + Math.floor((lowSlackM * (high - low)) / (lowSlackM - highSlackM));
      const middle =
        streak >= 2 ? Math.floor((low + high) / 2) : Math.min(Math.max(aimedM, low + 1), high - 1);
      const middleSlackM = slackM(middle);
      const held = middleSlackM >= 0;
      streak = held === lastHeld ? streak + 1 : 1;
      lastHeld = held;
      if (held) {
        low = middle;
        lowSlackM = middleSlackM;
      } else {
        high = middle;
        highSlackM = middleSlackM;
      }
    }
    return low;
  }
  // Below a long run the week does not hold, the longest it does. A week that cannot place its last few
  // meters (the easy run would be under 20 min) gives those meters up from the long run, rather than
  // cutting the long run to its share of the shorter week. Where the long run the week as built allows
  // does not hold either, the search aims at the line's zero below the two long runs tried (twice as far
  // down where the line has none) until one holds; no long run at all always does.
  const longestHeldM = (tooLongM: number, tooLongSlackM: number) => {
    let high = tooLongM;
    let highSlackM = tooLongSlackM;
    let low = tooLongM + tooLongSlackM;
    for (;;) {
      if (low <= 0) return boundaryM(0, 0, high, highSlackM);
      const lowSlackM = slackM(low);
      if (lowSlackM >= 0) return boundaryM(low, lowSlackM, high, highSlackM);
      const rise = highSlackM - lowSlackM;
      const aimedM = rise < 0 ? low - Math.ceil((lowSlackM * (high - low)) / rise) : 2 * low - high;
      high = low;
      highSlackM = lowSlackM;
      low = Math.max(0, Math.min(aimedM, low - 1));
    }
  };
  // Once reps come off or the work is sized again, the long run is too: the most the target allows when
  // the week holds it, else the longest the week holds, searched from the long run it had, which finds
  // the same long run as a search down from the most the target allows in a few builds.
  const resizedLongM = (fromM: number) => {
    const topM = longFor(targetM);
    if (!hasLong) return topM;
    const topSlackM = slackM(topM);
    if (topSlackM >= 0) return topM;
    if (fromM >= topM) return longestHeldM(topM, topSlackM);
    const fromSlackM = slackM(fromM);
    return fromSlackM >= 0
      ? boundaryM(fromM, fromSlackM, topM, topSlackM)
      : longestHeldM(fromM, fromSlackM);
  };

  if (targetM <= fixedM) return { sessions: [], fillDates: [] };
  let longM = longFor(targetM);
  for (;;) {
    const { placed, sessions, actualM, finishM, stridesAt, fillDates } = build(longM);
    const longSlackM = longFor(actualM) - longM;
    if (hasLong && longSlackM < 0) {
      longM = longestHeldM(longM, longSlackM);
      continue;
    }
    // A long run shortened to what the sessions hold may now be under a quality session: a rep comes
    // off it, so the long run stays the longest run.
    const passing = placed.find((p) => hasLong && baseM(p.work, ctx.paces) > longM);
    if (passing !== undefined) {
      drops[passing.slot]! += 1;
      longM = resizedLongM(longM);
      continue;
    }
    // Shorter work leaves the long run more room, so it is sized again.
    if (placed.some((p) => p.work.reps * p.work.repM > workCapM(p.work.zone, actualM))) {
      workSizeM = actualM;
      longM = resizedLongM(longM);
      continue;
    }
    // Under 80% easy, the finish shortens first, then the strides go, then reps come off the hardest
    // session; only these slots' reps can: the fixed sessions were sized where they belong. The finish
    // and strides are carved out of their runs, so the long run keeps its size.
    if (!holdsEasyShare([...sessions, ...fixed], ctx.paces)) {
      if (finishM > 0) {
        finishCuts += 1;
        continue;
      }
      if (stridesAt !== null) {
        strides = false;
        continue;
      }
      if (placed.length > 0) {
        drops[placed[hardIndexToDrop(placed, ctx.paces)]!.slot]! += 1;
        longM = resizedLongM(longM);
        continue;
      }
    }
    return { sessions, fillDates };
  }
}

/** The long run's day as an easy day, the last in fill order: a week that runs no long run. */
function withoutLongRun(slots: Slots): Slots {
  return slots.long === null ? slots : { ...slots, long: null, easy: [...slots.easy, slots.long] };
}

/** A base, build, peak or taper week from Monday to Sunday: its slots, sized for its target. */
export function buildTrainingWeek(ctx: PlanContext, input: TrainingWeekInput): BuiltWeek {
  const laidOut = weekSlots(ctx, input);
  const slots = input.longRun === false ? withoutLongRun(laidOut) : laidOut;
  const sessions = sizeWeek(ctx, {
    slots,
    keepsBaselineLongest: KEEPS_BASELINE_LONGEST.has(input.phase),
    targetM: input.targetM,
    maxRunM: input.maxRunM,
    weekNumber: input.number,
    fastFinish: input.fastFinish,
  });
  return { ...finishWeek(input.number, input.phase, input.weekStart, sessions), slots };
}
