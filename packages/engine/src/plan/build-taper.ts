import type { GeneratedSession, GeneratedWeek, PlanPhase } from "@running-coach/shared";
import { HARD_SESSION_TYPES, RACE_WEEK_DAYS } from "../constants";
import { addDays, daysBetween } from "../dates";
import { longestInWindowM, maxRunM } from "../rules/long-run";
import { qualityCount, taperKeepsWork } from "../rules/quality";
import {
  practiceReps,
  raceWeekDays,
  raceWeekSessions,
  raceWeekShortestM,
} from "../rules/race-week";
import { taperPeakM } from "../rules/taper";
import { longRunKeepsDay } from "../rules/taper-long-run";
import { isRaceBandWeek, taperCeilingM } from "../rules/taper-share";
import { weekTargetM } from "../rules/volume-curve";
import {
  finishWeek,
  raceSession,
  sizeWeek,
  sumM,
  weekRunCaps,
  weekSlots,
  type BuiltWeek,
  type PlanContext,
  type Slots,
} from "./build-week";

export interface TaperWeeksInput {
  /** Every week's phase, the race week last. */
  phases: readonly PlanPhase[];
  startDate: string;
  startVolumeM: number;
  /** The baseline's longest run, standing for the 4 weeks before the plan. */
  seedM: number;
  /** The base, build and peak weeks, as built. */
  preTaper: readonly BuiltWeek[];
}

const nonRace = (sessions: readonly GeneratedSession[]) =>
  sessions.filter((s) => s.type !== "race");

/**
 * Every week of a race plan from its base, build and peak weeks. Each taper week, Monday to Sunday,
 * holds at most its share of the taper peak (taper-share.ts) and never more than the week before as
 * built, the race excluded. The 6 days before the race belong to the race week's template
 * (race-week.ts), wherever they fall: a Thursday to Saturday race's begin in its 70% week, a Monday to
 * Wednesday race's in its 40% week, which also runs up to 2 easy runs 7 to 9 days out and nothing else,
 * each within that week's own run cap (weekRunCaps), as in any week that runs no long run.
 * Every other taper day keeps its week's layout: the long run on its day while 6 or more days out,
 * within its cap by days to the race (none where that is under 20 min: its day runs easy); race
 * practice and, from 4 days a week, tempo, which runs easy under 10 days out; a week holding the
 * template's race practice keeps its quality count with it. A week the template's days leave under
 * 20 min runs no long run beside them (sizeWeek).
 * The template is sized first, its days in the week before the race week fixed there. When they leave
 * that week nothing of its own though its ceiling holds them at 20 min and one 20 min run more, they
 * get its ceiling less 20 min and are sized again: their easy days shorten before its own days give
 * way. When the race week would then hold more than the week before as built, its cap comes down to
 * that and it is sized again, with no more race-pace reps than it ran (a practice back at full reps
 * would rest under the lower cap), so every cap holds by construction.
 */
export function buildTaperWeeks(ctx: PlanContext, input: TaperWeeksInput): GeneratedWeek[] {
  const { phases, startDate, startVolumeM, seedM, preTaper } = input;
  const raceDate = ctx.raceDate!;
  const { distanceKey } = ctx;
  const weekStarts = phases.map((_, k) => addDays(startDate, 7 * k));
  const byWeek: GeneratedSession[][] = phases.map(() => []);
  preTaper.forEach((built, k) => byWeek[k]!.push(...built.week.sessions));
  const daysOut = (date: string) => daysBetween(date, raceDate);
  const weekOf = (date: string) => Math.floor(daysBetween(startDate, date) / 7);
  const raceIndex = phases.length - 1;
  const peakM = taperPeakM({ weeksM: preTaper.map((built) => built.week.distanceM), startVolumeM });

  const builtM = (k: number) => sumM(nonRace(byWeek[k]!));
  const shareCapM = (k: number) =>
    taperCeilingM({ distanceKey, raceDate, weekStart: weekStarts[k]!, peakM })!;
  // A taper week's share of the peak, never over the week before as built.
  const ceilingM = (k: number) =>
    weekTargetM({
      kind: "eased",
      volumeM: shareCapM(k),
      previousWeekM: k === 0 ? null : builtM(k - 1),
    });
  const sessionsBefore = (k: number) => byWeek.slice(0, k).flat();
  const lastHardBefore = (k: number) =>
    sessionsBefore(k)
      .filter((s) => HARD_SESSION_TYPES.has(s.type))
      .map((s) => s.date)
      .sort()
      .at(-1) ?? null;
  // No run over 110% of the longest of the 4 weeks before; a week not built yet counts as none.
  const runCapM = (k: number) =>
    maxRunM(
      longestInWindowM({
        longestByWeekM: byWeek
          .slice(0, k)
          .map((sessions) => Math.max(0, ...nonRace(sessions).map((s) => s.target.distanceM))),
        seedM,
      }),
    );
  const weekCaps = (k: number) =>
    weekRunCaps(ctx, {
      runCapM: runCapM(k),
      weekStart: weekStarts[k]!,
      longRunsBeforeM: sessionsBefore(k)
        .filter((s) => s.type === "long")
        .map((s) => s.target.distanceM),
      seedM,
    });

  // A taper week's own days: the race week's days and a long run under 6 days out go to the race
  // week; a long run whose cap by days is under 20 min runs easy on a day of the week's own.
  const ownSlots = (k: number): Slots => {
    const slots = weekSlots(ctx, {
      number: k + 1,
      phase: "taper",
      weekStart: weekStarts[k]!,
      lastHardDate: lastHardBefore(k),
    });
    const own = (date: string) => daysOut(date) > RACE_WEEK_DAYS;
    const quality = slots.quality.filter(
      (slot) => own(slot.date) && taperKeepsWork({ zone: slot.zone, daysOut: daysOut(slot.date) }),
    );
    const { longRun } = weekCaps(k);
    return {
      long:
        longRun && slots.long !== null && longRunKeepsDay(daysOut(slots.long)) ? slots.long : null,
      quality,
      easy: [
        ...slots.easy.filter(own),
        ...slots.quality
          .filter((slot) => own(slot.date) && !quality.includes(slot))
          .map((slot) => slot.date),
        ...(!longRun && slots.long !== null && own(slots.long) ? [slots.long] : []),
      ],
    };
  };
  const sizeOwn = (k: number, slots: Slots, fixed: readonly GeneratedSession[]) =>
    sizeWeek(ctx, {
      slots,
      fixed,
      keepsBaselineLongest: false,
      targetM: ceilingM(k),
      maxRunM: weekCaps(k).maxRunM,
      weekNumber: k + 1,
      fastFinish: false,
    });

  // The race week's days begin in the week before it unless the race is on a Sunday.
  const before = raceIndex - 1;
  const spansTwoWeeks =
    before >= preTaper.length && daysOut(addDays(weekStarts[raceIndex]!, -1)) <= RACE_WEEK_DAYS;
  for (let k = preTaper.length; k < (spansTwoWeeks ? before : raceIndex); k += 1) {
    byWeek[k]!.push(...sizeOwn(k, ownSlots(k), []));
  }

  // The week before keeps days of its own unless it is in the race band (a Monday to Wednesday race).
  const beforeSlots =
    spansTwoWeeks && !isRaceBandWeek({ raceDate, weekStart: weekStarts[before]! })
      ? ownSlots(before)
      : null;
  const laidOutDates = beforeSlots === null ? [] : slotDates(beforeSlots);
  const days = raceWeekDays({
    raceDate,
    startDate,
    daysPerWeek: ctx.daysPerWeek,
    // The week before's own hard days, as laid out, come after every earlier week's.
    lastHardDate:
      (beforeSlots === null ? [] : hardDates(beforeSlots)).sort().at(-1) ??
      lastHardBefore(spansTwoWeeks ? before : raceIndex),
    laidOutDates,
  });
  // The week before keeps its quality count with the race week's practice in it.
  const room =
    qualityCount({ phase: "taper", daysPerWeek: ctx.daysPerWeek }) -
    days.filter((day) => day.kind === "practice" && weekOf(day.date) === before).length;
  const ownBefore: Slots | null =
    beforeSlots === null
      ? null
      : {
          ...beforeSlots,
          quality: beforeSlots.quality.slice(0, room),
          easy: [...beforeSlots.easy, ...beforeSlots.quality.slice(room).map((slot) => slot.date)],
        };

  const windowCapM = shareCapM(raceIndex);
  let raceWeekCapM = spansTwoWeeks ? windowCapM : ceilingM(raceIndex);
  // What the template's days may take of the week before: its ceiling, less 20 min once they would
  // leave it no run of its own.
  const beforeCeilingM = spansTwoWeeks ? ceilingM(before) : 0;
  let beforeCapM = beforeCeilingM;
  // Sized again, the race week runs no more race-pace reps than it did.
  let maxReps: number | undefined;
  for (;;) {
    const template = raceWeekSessions({
      days,
      daysPerWeek: ctx.daysPerWeek,
      takenDates: [...laidOutDates, raceDate],
      distanceKey,
      paces: ctx.paces,
      maxRunM: Math.min(runCapM(raceIndex), ...(spansTwoWeeks ? [runCapM(before)] : [])),
      // The extra days fall in the week before, a race-band week that runs no long run.
      ...(spansTwoWeeks ? { extraMaxRunM: weekCaps(before).maxRunM } : {}),
      windowCapM,
      weekCapsM: {
        ...(spansTwoWeeks ? { [weekStarts[before]!]: beforeCapM } : {}),
        [weekStarts[raceIndex]!]: raceWeekCapM,
      },
      ...(maxReps === undefined ? {} : { maxReps }),
    });
    maxReps = practiceReps(template) ?? maxReps;
    const inRaceWeek = template.filter((s) => weekOf(s.date) === raceIndex);
    if (!spansTwoWeeks) {
      byWeek[raceIndex]!.push(...inRaceWeek);
      break;
    }
    const inBefore = template.filter((s) => weekOf(s.date) === before);
    const own = ownBefore === null ? [] : sizeOwn(before, ownBefore, inBefore);
    // Once only: the template's days shorten so the week before keeps a 20 min run of its own.
    if (
      own.length === 0 &&
      ownBefore !== null &&
      slotDates(ownBefore).length > 0 &&
      beforeCapM === beforeCeilingM &&
      beforeCeilingM - raceWeekShortestM(inBefore, ctx.minRunM) >= ctx.minRunM
    ) {
      beforeCapM = beforeCeilingM - ctx.minRunM;
      continue;
    }
    const beforeM = sumM(own) + sumM(inBefore);
    if (sumM(inRaceWeek) <= beforeM) {
      byWeek[before]!.push(...own, ...inBefore);
      byWeek[raceIndex]!.push(...inRaceWeek);
      break;
    }
    // Never rising: the race week comes down to the week before as built, and is sized again.
    raceWeekCapM = beforeM;
  }
  byWeek[raceIndex]!.push(raceSession(raceDate, distanceKey, ctx.paces));

  return phases.map((phase, k) => finishWeek(k + 1, phase, weekStarts[k]!, byWeek[k]!).week);
}

function hardDates(slots: Slots): string[] {
  return [...(slots.long === null ? [] : [slots.long]), ...slots.quality.map((slot) => slot.date)];
}

function slotDates(slots: Slots): string[] {
  return [...hardDates(slots), ...slots.easy];
}
