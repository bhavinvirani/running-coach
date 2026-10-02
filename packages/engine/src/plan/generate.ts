import {
  DISTANCE_METERS,
  planGenerationInputSchema,
  type PlanGenerationInput,
  type PlanGenerationResult,
  type PlanPaces,
  type PlanPhase,
  type PlanWarning,
} from "@running-coach/shared";
import { ENGINE_VERSION, FITNESS_SHAPE_DISTANCE, PEAK_VOLUME_M } from "../constants";
import { addDays } from "../dates";
import { startVolume } from "../rules/baseline";
import {
  longestInWindowM,
  longestRunSeedM,
  longRunDaysConflict,
  longRunM,
  longRunWarning,
  maxRunM,
  requiredLongRunM,
} from "../rules/long-run";
import { planLength } from "../rules/plan-length";
import { predictTimeS, racePace } from "../rules/prediction";
import { bandMidpointSPerKm } from "../rules/session-target";
import { peakPhaseVolumeM, taperVolumesM } from "../rules/taper";
import { pacesFromVdot, roundVdot, vdotFromPerformance } from "../rules/vdot";
import { baseCurveM, isDownWeek, weekTargetM } from "../rules/volume-curve";
import { minRunDistanceM, tooManyDaysConflict } from "../rules/week-fill";
import { buildRaceWeek, buildTrainingWeek, type BuiltWeek, type PlanContext } from "./build-week";

const PRE_TAPER: readonly PlanPhase[] = ["base", "build", "peak"];

function buildWeeks(
  ctx: PlanContext,
  {
    phases,
    startDate,
    startVolumeM,
    seedM,
  }: {
    phases: readonly PlanPhase[];
    startDate: string;
    startVolumeM: number;
    seedM: number;
  },
): BuiltWeek[] {
  const preTaperWeeks = phases.filter((phase) => PRE_TAPER.includes(phase)).length;
  const curve = baseCurveM({
    startVolumeM,
    peakVolumeM: PEAK_VOLUME_M[ctx.distanceKey],
    weeks: preTaperWeeks,
  });
  const built: BuiltWeek[] = [];
  let taper: number[] | null = null;
  let previousNonDownM: number | null = null;
  phases.forEach((phase, index) => {
    const number = index + 1;
    const weekStart = addDays(startDate, 7 * index);
    const previous = built.at(-1);
    const lastHardDate = built.findLast((week) => week.lastHardDate !== null)?.lastHardDate ?? null;
    const runCapM = maxRunM(
      longestInWindowM({ longestByWeekM: built.map((w) => w.longestM), seedM }),
    );
    if (PRE_TAPER.includes(phase)) {
      const down = isDownWeek(number);
      const targetM = down
        ? weekTargetM({
            kind: "down",
            curveM: curve[index]!,
            previousWeekM: previous!.week.distanceM,
          })
        : weekTargetM({
            kind: "climb",
            curveM: curve[index]!,
            previousNonDownWeekM: previousNonDownM,
          });
      const week = buildTrainingWeek(ctx, {
        number,
        phase,
        weekStart,
        targetM,
        maxRunM: runCapM,
        lastHardDate,
      });
      if (!down) previousNonDownM = week.week.distanceM;
      built.push(week);
      return;
    }
    taper ??= taperVolumesM({
      distanceKey: ctx.distanceKey,
      peakVolumeM: peakPhaseVolumeM({ weeks: built.map((w) => w.week), startVolumeM }),
      weeks: phases.length - preTaperWeeks,
    });
    const targetM = weekTargetM({
      kind: "eased",
      volumeM: taper[index - preTaperWeeks]!,
      previousWeekM: previous?.week.distanceM ?? null,
    });
    if (phase === "taper") {
      built.push(
        buildTrainingWeek(ctx, {
          number,
          phase,
          weekStart,
          targetM,
          maxRunM: runCapM,
          lastHardDate,
        }),
      );
      return;
    }
    // A plan that starts in race week has no long run before it: its own volume sets the cap.
    const capM = Math.min(
      runCapM,
      previous?.longRunCapM ??
        longRunM({
          weekVolumeM: targetM,
          daysPerWeek: ctx.daysPerWeek,
          easyPaceSPerKm: ctx.easyPaceSPerKm,
          maxRunM: runCapM,
        }),
    );
    built.push(buildRaceWeek(ctx, { number, weekStart, targetM, capM, lastHardDate }));
  });
  return built;
}

/**
 * The training plan for a goal: every week from the first Monday to the race (or 12 weeks for a
 * fitness goal), each number from a rule in src/rules. A goal the rules cannot serve at the runner's
 * days and baseline is a conflict, returned rather than bent. Pure: the same input gives the same
 * plan, byte for byte. An input the contract rejects is a programmer error and throws.
 */
export function generatePlan(rawInput: PlanGenerationInput): PlanGenerationResult {
  const { goal, startDate, baseline, vdotSource } = planGenerationInputSchema.parse(rawInput);
  if (vdotSource === null) return { ok: false, conflict: { code: "no_recent_time" } };
  const distanceKey = goal.distanceKey ?? FITNESS_SHAPE_DISTANCE;
  const length = planLength({ kind: goal.kind, distanceKey, startDate, raceDate: goal.raceDate });
  if (!length.ok) return { ok: false, conflict: length.conflict };
  const daysConflict = longRunDaysConflict({ distanceKey, daysPerWeek: goal.daysPerWeek });
  if (daysConflict !== null) return { ok: false, conflict: daysConflict };

  const vdot = roundVdot(vdotFromPerformance(vdotSource));
  const predictedTimeS = predictTimeS({
    fromDistanceM: vdotSource.distanceM,
    fromTimeS: vdotSource.timeS,
    toDistanceM: DISTANCE_METERS[distanceKey],
  });
  const race = racePace({
    distanceM: DISTANCE_METERS[distanceKey],
    predictedTimeS,
    targetTimeS: goal.targetTimeS,
  });
  const paces: PlanPaces = { ...pacesFromVdot(vdot), race: race.band };
  const easyPaceSPerKm = bandMidpointSPerKm(paces.easy);
  const minRunM = minRunDistanceM(easyPaceSPerKm);
  const start = startVolume({ baseline, distanceKey });
  const daysOverVolume = tooManyDaysConflict({
    daysPerWeek: goal.daysPerWeek,
    startVolumeM: start.startVolumeM,
    minRunM,
  });
  if (daysOverVolume !== null) return { ok: false, conflict: daysOverVolume };

  const built = buildWeeks(
    {
      distanceKey,
      daysPerWeek: goal.daysPerWeek,
      longRunDay: goal.longRunDay,
      raceDate: goal.raceDate,
      paces,
      easyPaceSPerKm,
      minRunM,
    },
    {
      phases: length.phases,
      startDate,
      startVolumeM: start.startVolumeM,
      seedM: longestRunSeedM(baseline.longestRunM),
    },
  );
  const preTaperLongRunsM = built
    .filter((week) => PRE_TAPER.includes(week.week.phase) && week.longRunM !== null)
    .map((week) => week.longRunM!);
  const longRunShort =
    preTaperLongRunsM.length === 0
      ? null
      : longRunWarning({
          peakLongRunM: Math.max(...preTaperLongRunsM),
          requiredLongRunM: requiredLongRunM({ distanceKey, easyPaceSPerKm }),
        });
  const warnings = [length.warning, start.warning, longRunShort, race.warning].filter(
    (warning): warning is PlanWarning => warning !== null,
  );
  return {
    ok: true,
    plan: {
      engineVersion: ENGINE_VERSION,
      startDate,
      endDate: length.endDate,
      vdot,
      paces,
      warnings,
      weeks: built.map((week) => week.week),
    },
  };
}
