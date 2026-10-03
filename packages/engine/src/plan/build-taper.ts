import type { GeneratedSession, GeneratedWeek, PlanPhase } from "@running-coach/shared";
import { HARD_SESSION_TYPES, TAPER_BLOCK_DAYS } from "../constants";
import { addDays, daysBetween } from "../dates";
import { longestInWindowM, longRunM, maxRunM } from "../rules/long-run";
import { raceWeekDays, taperPracticeDate } from "../rules/race-week";
import {
  taperBlocks,
  taperPeakM,
  taperStartDate,
  taperVolumesM,
  type TaperBlock,
} from "../rules/taper";
import { weekTargetM } from "../rules/volume-curve";
import {
  finishWeek,
  raceSession,
  sizeRaceBlock,
  sizeWeek,
  sumM,
  weekSlots,
  type BuiltWeek,
  type PlanContext,
  type Slots,
} from "./build-week";

/** A base, build or peak week as built, with what it was built for. */
export interface PreTaperWeek extends BuiltWeek {
  targetM: number;
  /** 110% of the longest run of the 4 weeks before it. */
  maxRunM: number;
}

export interface TaperWeeksInput {
  /** Every week's phase, the race week last. */
  phases: readonly PlanPhase[];
  startDate: string;
  startVolumeM: number;
  /** The baseline's longest run, standing for the 4 weeks before the plan. */
  seedM: number;
  /** The base, build and peak weeks, built whole. */
  preTaper: readonly PreTaperWeek[];
}

const NO_SLOTS: Slots = { long: null, quality: [], easy: [] };

function within(slots: Slots, firstDate: string, lastDate: string): Slots {
  const inside = (date: string) =>
    daysBetween(firstDate, date) >= 0 && daysBetween(date, lastDate) >= 0;
  return {
    long: slots.long !== null && inside(slots.long) ? slots.long : null,
    quality: slots.quality.filter((slot) => inside(slot.date)),
    easy: slots.easy.filter(inside),
  };
}

function merge(a: Slots, b: Slots): Slots {
  return {
    long: a.long ?? b.long,
    quality: [...a.quality, ...b.quality],
    easy: [...a.easy, ...b.easy],
  };
}

const hardDatesOf = (slots: Slots) => [
  ...(slots.long === null ? [] : [slots.long]),
  ...slots.quality.map((slot) => slot.date),
];

/**
 * Every week of a race plan from its base, build and peak weeks: the taper is sized in 7-day blocks
 * counted back from race day (taperBlocks), so the 7 days before any race hold 40% of the peak and the
 * 7 before those the next share, whatever the race's weekday. Each week keeps its own layout; a block
 * takes the slots of the days it covers, from one week or two, and sizes them like a week. The 7 days
 * before the race run no long run and one race practice at most, at least 3 days out, and rest the day
 * before. When the taper starts inside the last peak week, that week's days before it are sized after
 * the first block, beside its sessions, for no more than the whole week gave them and within the
 * week's target, so the week keeps its rules. The first block leaves them 20 min each of that target:
 * when its runs on the week's taper days would take more, its volume comes down until they do not.
 * A block rests a day it lays out only when its easy runs cannot take one more 20 min run (fillWeek
 * places min(days, max(floor(easy / 20 min), ceil(easy / long run))) runs), as when the taper's share
 * of the peak is short of 20 min on each day; the weeks it covers, the one the taper starts in
 * included, then run fewer than the days asked for.
 */
export function buildTaperWeeks(ctx: PlanContext, input: TaperWeeksInput): GeneratedWeek[] {
  const { phases, startDate, startVolumeM, seedM, preTaper } = input;
  const raceDate = ctx.raceDate!;
  const taperStart = taperStartDate({ distanceKey: ctx.distanceKey, raceDate });
  const blockOneStart = addDays(raceDate, -TAPER_BLOCK_DAYS);
  const blocks = taperBlocks({ distanceKey: ctx.distanceKey, raceDate, startDate });
  const weekStarts = phases.map((_, k) => addDays(startDate, 7 * k));
  const weekOf = (date: string) => Math.floor(daysBetween(startDate, date) / 7);
  const byWeek: GeneratedSession[][] = phases.map(() => []);

  const last = preTaper.at(-1);
  const straddler =
    last !== undefined && daysBetween(last.week.startDate, taperStart) < 7 ? last : null;
  const whole = straddler === null ? preTaper : preTaper.slice(0, -1);
  whole.forEach((built, k) => byWeek[k]!.push(...built.week.sessions));

  // Hard days as laid out: sizing can turn a hard slot easy, never an easy one hard.
  const hardDates = whole.flatMap((built) =>
    built.week.sessions.filter((s) => HARD_SESSION_TYPES.has(s.type)).map((s) => s.date),
  );
  if (straddler !== null) hardDates.push(...hardDatesOf(straddler.slots));
  const lastHardBefore = (date: string) =>
    hardDates
      .filter((hard) => daysBetween(hard, date) > 0)
      .sort()
      .at(-1) ?? null;

  const taperWeekSlots: Slots[] = [];
  phases.forEach((phase, k) => {
    if (phase !== "taper") return;
    const slots = weekSlots(ctx, {
      number: k + 1,
      phase,
      weekStart: weekStarts[k]!,
      lastHardDate: lastHardBefore(weekStarts[k]!),
    });
    hardDates.push(...hardDatesOf(slots));
    taperWeekSlots.push(slots);
  });

  const raceWeekStart = weekStarts.at(-1)!;
  const raceDays = raceWeekDays({
    weekStart: raceWeekStart,
    raceDate,
    longRunDay: ctx.longRunDay,
    daysPerWeek: ctx.daysPerWeek,
    lastHardDate: lastHardBefore(blockOneStart),
  });
  // The 7 days before the race: the week before the race week's long run there runs easy, and its
  // quality day stays race practice only when the race week holds none.
  const inBlockOne = (date: string) => daysBetween(blockOneStart, date) >= 0;
  const keptPractice = taperPracticeDate({
    qualityDates: taperWeekSlots.flatMap((slots) =>
      slots.quality.filter((slot) => inBlockOne(slot.date)).map((slot) => slot.date),
    ),
    raceDate,
    raceWeekPracticeDate: raceDays.racePracticeDate,
  });
  const eased = taperWeekSlots.map((slots): Slots => ({
    long: slots.long !== null && inBlockOne(slots.long) ? null : slots.long,
    quality: slots.quality.filter((slot) => !inBlockOne(slot.date) || slot.date === keptPractice),
    easy: [
      ...slots.easy,
      ...(slots.long !== null && inBlockOne(slots.long) ? [slots.long] : []),
      ...slots.quality
        .filter((slot) => inBlockOne(slot.date) && slot.date !== keptPractice)
        .map((slot) => slot.date),
    ],
  }));
  const raceWeekSlots: Slots = {
    long: null,
    quality:
      raceDays.racePracticeDate === null ? [] : [{ date: raceDays.racePracticeDate, zone: "race" }],
    easy: raceDays.easyDates,
  };
  const taperSlots = [
    straddler === null ? NO_SLOTS : within(straddler.slots, taperStart, addDays(raceDate, -1)),
    ...eased,
    raceWeekSlots,
  ];
  const blockSlots = (block: TaperBlock) =>
    taperSlots
      .map((slots) => within(slots, block.firstDate, block.lastDate))
      .reduce(merge, NO_SLOTS);

  // No run over 110% of the longest of the 4 weeks before its week, as far as they are sized yet: a
  // week sized later only raises the cap, so this one holds for both weeks a block covers.
  const runCapM = (week: number) =>
    maxRunM(
      longestInWindowM({
        longestByWeekM: byWeek
          .slice(0, week)
          .map((sessions) =>
            Math.max(
              0,
              ...sessions.filter((s) => s.type !== "race").map((s) => s.target.distanceM),
            ),
          ),
        seedM,
      }),
    );

  const peakM = taperPeakM({ weeksM: whole.map((built) => built.week.distanceM), startVolumeM });
  const volumesM =
    blocks.length === 0
      ? []
      : taperVolumesM({ distanceKey: ctx.distanceKey, peakVolumeM: peakM, blocks: blocks.length });
  // The first block never rises over the last whole week, nor over the target of the week it starts
  // in, which holds the block's first days beside its own.
  let previousM: number | null = whole.at(-1)?.week.distanceM ?? null;
  if (straddler !== null) previousM = Math.min(previousM ?? straddler.targetM, straddler.targetM);
  const straddlerIndex = straddler === null ? -1 : straddler.week.number - 1;
  const keptBefore = (session: GeneratedSession) => daysBetween(session.date, taperStart) > 0;
  const keptSlots =
    straddler === null
      ? NO_SLOTS
      : within(straddler.slots, straddler.week.startDate, addDays(taperStart, -1));
  // The straddler's target less 20 min on each day it lays out before the taper.
  const keptDays = hardDatesOf(keptSlots).length + keptSlots.easy.length;
  const straddlerRoomM =
    straddler === null ? 0 : Math.max(0, straddler.targetM - ctx.minRunM * keptDays);
  const inStraddlerM = (sessions: readonly GeneratedSession[]) =>
    sumM(sessions.filter((session) => weekOf(session.date) === straddlerIndex));
  blocks.forEach((block, k) => {
    const targetM = weekTargetM({
      kind: "eased",
      volumeM: volumesM[k]!,
      previousWeekM: previousM,
    });
    const capM = Math.min(runCapM(weekOf(block.firstDate)), runCapM(weekOf(block.lastDate)));
    const slots = blockSlots(block);
    const sizeBlock = (blockM: number) =>
      block.number === 1
        ? sizeRaceBlock(ctx, {
            practiceDate: slots.quality[0]?.date ?? null,
            easyDates: slots.easy,
            targetM: blockM,
            // No run passes the long run the block before allowed.
            capM: longRunM({
              weekVolumeM: previousM ?? blockM,
              daysPerWeek: ctx.daysPerWeek,
              easyPaceSPerKm: ctx.easyPaceSPerKm,
              maxRunM: capM,
            }),
          })
        : sizeWeek(ctx, { slots, keepsBaselineLongest: false, targetM: blockM, maxRunM: capM });
    let sessions = sizeBlock(targetM);
    if (straddler !== null && k === 0 && inStraddlerM(sessions) > straddlerRoomM) {
      // The largest block whose runs in the straddler leave 20 min to each of its days before the
      // taper; an empty block takes none.
      let fitsM = 0;
      let tooMuchM = targetM;
      while (tooMuchM - fitsM > 1) {
        const middleM = Math.floor((fitsM + tooMuchM) / 2);
        if (inStraddlerM(sizeBlock(middleM)) <= straddlerRoomM) fitsM = middleM;
        else tooMuchM = middleM;
      }
      sessions = sizeBlock(fitsM);
    }
    sessions.forEach((session) => byWeek[weekOf(session.date)]!.push(session));
    // A block the plan's start cut short ran only part of its 7 days: it caps nothing after it.
    const ranAllDays = daysBetween(block.firstDate, block.lastDate) === TAPER_BLOCK_DAYS - 1;
    previousM = ranAllDays ? sumM(sessions) : null;
    if (straddler !== null && k === 0) {
      // The last peak week's days before the taper: what the whole week gave them, sized again beside
      // the block's sessions so the week keeps its rules and never passes its target.
      const index = straddlerIndex;
      const tail = [...byWeek[index]!];
      const kept = sizeWeek(ctx, {
        slots: keptSlots,
        fixed: tail,
        keepsBaselineLongest: true,
        targetM: Math.min(
          straddler.targetM,
          sumM(straddler.week.sessions.filter(keptBefore)) + sumM(tail),
        ),
        maxRunM: straddler.maxRunM,
      });
      byWeek[index]!.push(...kept);
    }
  });
  byWeek.at(-1)!.push(raceSession(raceDate, ctx.distanceKey, ctx.paces));

  return phases.map((phase, k) => finishWeek(k + 1, phase, weekStarts[k]!, byWeek[k]!).week);
}
