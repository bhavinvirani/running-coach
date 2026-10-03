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
import { HARD_SESSION_TYPES } from "../constants";
import { addDays, daysBetween, weekdayIndex } from "../dates";
import { hardShareHolds, hardTimeS } from "../rules/easy-share";
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
  qualitySteps,
  qualityWork,
  qualityZones,
  workCapM,
  type Work,
  type WorkZone,
} from "../rules/quality";
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

/** A quality session's day and the zone of its work. */
export interface QualitySlot {
  date: string;
  zone: WorkZone;
}

/**
 * The days a week, or a taper block, runs and what each holds; a day not named is rest. A session
 * that would fall on the day before the race has already moved to a free day as an easy run.
 */
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
  /** 110% of the longest run of the last 4 weeks. */
  maxRunM: number;
}

export interface SizeWeekInput {
  slots: Slots;
  /**
   * Sessions already in the week, sized elsewhere: they count towards its volume, its shares and its
   * easy time, and a fixed long run caps the others. Empty for a whole week or a taper block.
   */
  fixed?: readonly GeneratedSession[];
  /** Base, build and peak long runs never drop under the runner's own longest run. */
  keepsBaselineLongest: boolean;
  /** The week's volume, the fixed sessions included. */
  targetM: number;
  /** No run over this: 110% of the longest run of the last 4 weeks. */
  maxRunM: number;
}

export interface SizeRaceBlockInput {
  /** The race practice's day, null with none. */
  practiceDate: string | null;
  /** In fill order. */
  easyDates: readonly string[];
  /** The block's running, the race excluded. */
  targetM: number;
  /** No run passes the long run the block before allowed or 110% of the recent longest. */
  capM: number;
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
 * Which day of a Monday-to-Sunday week holds the long run, each quality session and each easy run.
 * Only the week holding the day before a Monday race has it: that day is rest, and a session planned
 * there, the long run too, moves to the latest free day as an easy run.
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
  const blocked = ctx.raceDate === null ? null : addDays(ctx.raceDate, -1);
  const longDate = dateOf(layout.longRun);
  const qualityDates = layout.quality.map(dateOf);
  const used = new Set([longDate, ...qualityDates, ...layout.easy.map(dateOf)]);
  const free = [6, 5, 4, 3, 2, 1, 0]
    .map((index) => addDays(weekStart, index))
    .filter((date) => !used.has(date) && date !== blocked);
  const movable = (date: string) => (date === blocked ? free.shift()! : date);
  const easy = layout.easy.map(dateOf).map(movable);
  const movedQuality = qualityDates.filter((date) => date === blocked).map(movable);
  const movedLong = longDate === blocked ? [movable(longDate)] : [];
  return {
    long: longDate === blocked ? null : longDate,
    quality: zones
      .map((zone, k) => ({ date: qualityDates[k]!, zone }))
      .filter((slot) => slot.date !== blocked),
    easy: [...easy, ...movedLong, ...movedQuality],
  };
}

/**
 * The sessions on a week's or a taper block's slots, for its target volume. The long run and quality
 * sessions come first, then easy runs fill the volume. Base, build and peak long runs never drop under
 * the runner's own longest (longRunFloorM), but every day comes first: the long run gives way down to
 * 20 min (longRunGivingWayM), then the last quality session gives its day to an easy run, so a 20 min
 * run fits on every day the volume allows. The long run stays the longest run: a second quality session
 * it would be shorter than runs easy, a lone one loses reps. The long run and each session's work are
 * measured against the sessions as built: when they hold less than the target, the long run shortens
 * to the longest they hold, or the work is sized from what they hold and the long run again, and they
 * are built again; reps come off the hardest session while easy time is under 80%. Each pass shortens
 * the long run, or shrinks the work, which only shrinks, so the loop ends. Slots with no long run still
 * size one: the long run their volume allows caps every other run. The long run's share follows the
 * days that run (longRunShare), so a block of fewer runs than the week still holds its volume.
 */
export function sizeWeek(
  ctx: PlanContext,
  { slots, fixed = [], keepsBaselineLongest, targetM, maxRunM }: SizeWeekInput,
): GeneratedSession[] {
  const zones = slots.quality.map((slot) => slot.zone);
  const hasLong = slots.long !== null;
  const fixedM = sumM(fixed);
  const fixedLongM = fixed.find((session) => session.type === "long")?.target.distanceM ?? null;
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
      const work = sizedWork(ctx, zone, workSizeM, drops[k]!, maxRunM);
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
      const longM = fixedLongM ?? longRunGivingWayM({ longM: capM, roomM, minRunM: ctx.minRunM });
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
  const longFor = (weekVolumeM: number) => shapeFor(weekVolumeM).longM;

  const build = (longM: number) => {
    const restM = targetM - fixedM - (hasLong ? longM : 0);
    const { quality } = shapeFor(targetM);
    const placed = quality.filter((p): p is Placed => p !== null);
    const fillSlots = [
      ...slots.easy,
      ...slots.quality.filter((_, k) => quality[k] === null).map((slot) => slot.date),
    ];
    const fill = fillWeek({
      restM,
      capM: longM,
      qualityM: placed.map((p) => baseM(p.work, ctx.paces)),
      easySlots: fillSlots.length,
      minRunM: ctx.minRunM,
    });
    const sessions = [
      ...(hasLong ? [runSession(slots.long!, "long", longM, ctx.paces)] : []),
      ...placed.map((p, k) => qualitySession(p, fill.qualityPadM[k]!, ctx.paces)),
      ...fill.easyRunsM.map((m, k) => runSession(fillSlots[k]!, "easy", m, ctx.paces)),
    ];
    return { placed, sessions, actualM: sumM(sessions) + fixedM };
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

  if (targetM <= fixedM) return [];
  let longM = longFor(targetM);
  for (;;) {
    const { placed, sessions, actualM } = build(longM);
    if (hasLong && longM > longFor(actualM)) {
      longM = longestHeldM(longFor(actualM), longM);
      continue;
    }
    // A long run shortened to what the sessions hold may now be under a quality session: a rep comes
    // off it, so the long run stays the longest run.
    const passing = placed.find((p) => hasLong && baseM(p.work, ctx.paces) > longM);
    if (passing !== undefined) {
      drops[passing.slot]! += 1;
      longM = longFor(targetM);
      continue;
    }
    // Shorter work leaves the long run more room, so it is sized again.
    if (placed.some((p) => p.work.reps * p.work.repM > workCapM(p.work.zone, actualM))) {
      workSizeM = actualM;
      longM = longFor(targetM);
      continue;
    }
    // Only these slots' reps can come off: the fixed sessions were sized where they belong.
    if (placed.length > 0 && !holdsEasyShare([...sessions, ...fixed], ctx.paces)) {
      drops[placed[hardIndexToDrop(placed, ctx.paces)]!.slot]! += 1;
      longM = longFor(targetM);
      continue;
    }
    return sessions;
  }
}

/** A base, build, peak or taper week from Monday to Sunday: its slots, sized for its target. */
export function buildTrainingWeek(ctx: PlanContext, input: TrainingWeekInput): BuiltWeek {
  const slots = weekSlots(ctx, input);
  const sessions = sizeWeek(ctx, {
    slots,
    keepsBaselineLongest: KEEPS_BASELINE_LONGEST.has(input.phase),
    targetM: input.targetM,
    maxRunM: input.maxRunM,
  });
  return { ...finishWeek(input.number, input.phase, input.weekStart, sessions), slots };
}

/**
 * The 7 days before the race: easy runs and one short race practice, the race excluded, at 80% easy
 * time on their own. Sized like a training week, without a long run.
 */
export function sizeRaceBlock(
  ctx: PlanContext,
  { practiceDate, easyDates, targetM, capM }: SizeRaceBlockInput,
): GeneratedSession[] {
  let workSizeM = targetM;
  let drops = 0;
  for (;;) {
    const sized = practiceDate === null ? null : sizedWork(ctx, "race", workSizeM, drops, capM);
    const work = sized !== null && baseM(sized, ctx.paces) <= targetM ? sized : null;
    const practice = work === null ? null : { date: practiceDate!, work, slot: 0 };
    const slots = [
      ...easyDates,
      ...(practice === null && practiceDate !== null ? [practiceDate] : []),
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
    if (
      practice !== null &&
      practice.work.reps * practice.work.repM > workCapM("race", sumM(running))
    ) {
      workSizeM = sumM(running);
      continue;
    }
    if (!holdsEasyShare(running, ctx.paces)) {
      drops += 1;
      continue;
    }
    return running;
  }
}
