import {
  DISTANCE_METERS,
  planGenerationInputSchema,
  type GeneratedWeek,
  type PlanConflict,
  type PlanGenerationInput,
  type PlanGenerationResult,
  type PlanPaces,
  type PlanPhase,
  type PlanWarning,
} from "@running-coach/shared";
import { ENGINE_VERSION, FITNESS_SHAPE_DISTANCE, PEAK_VOLUME_M } from "../constants";
import { addDays } from "../dates";
import { startVolume, type StartVolumeResult } from "../rules/baseline";
import {
  longestInWindowM,
  longestRunSeedM,
  longRunDaysConflict,
  longRunWarning,
  maxRunM,
  requiredLongRunM,
} from "../rules/long-run";
import { neededWeeklyM } from "../rules/needed-volume";
import { planLength } from "../rules/plan-length";
import { predictTimeS, racePace } from "../rules/prediction";
import { bandMidpointSPerKm } from "../rules/session-target";
import { pacesFromVdot, roundVdot, vdotFromPerformance } from "../rules/vdot";
import { fastFinishWeeks } from "../rules/fast-finish";
import { baseCurveM, isDownWeek, weekTargetM } from "../rules/volume-curve";
import { minRunDistanceM } from "../rules/week-fill";
import { buildTrainingWeek, weekRunCaps, type BuiltWeek, type PlanContext } from "./build-week";
import { buildTaperWeeks } from "./build-taper";

const PRE_TAPER: readonly PlanPhase[] = ["base", "build", "peak"];

interface Setup {
  ctx: PlanContext;
  startDate: string;
  phases: PlanPhase[];
  endDate: string;
  vdot: number;
  paces: PlanPaces;
  /** The longest run to grow from: the baseline's, never under the 5 km floor. */
  seedM: number;
  start: Extract<StartVolumeResult, { ok: true }>;
  lengthWarning: PlanWarning | null;
  raceWarning: PlanWarning | null;
}

/**
 * The base, build and peak weeks, each climbing at most 10% or recovering: a race plan's down weeks
 * counted back from its taper, a fitness plan's every 4th week. Every second build or peak week that is
 * not a down week ends its long run at marathon pace. A long run close enough to the race (a Thursday
 * race's last peak Sunday, 11 days out) keeps its cap by days to the race, a share of the largest long
 * run before it; where that is under 20 min the week runs its day easy instead (weekRunCaps).
 */
function buildPreTaperWeeks(
  ctx: PlanContext,
  {
    phases,
    startDate,
    startVolumeM,
    seedM,
  }: { phases: readonly PlanPhase[]; startDate: string; startVolumeM: number; seedM: number },
): BuiltWeek[] {
  const curve = baseCurveM({
    startVolumeM,
    peakVolumeM: PEAK_VOLUME_M[ctx.distanceKey],
    weeks: phases.length,
  });
  // A race plan's taper starts the week after these; a fitness plan has none.
  const firstTaperWeek = ctx.raceDate === null ? null : phases.length + 1;
  const downs = phases.map((_, index) => isDownWeek({ weekNumber: index + 1, firstTaperWeek }));
  const finishes = fastFinishWeeks(phases.map((phase, index) => ({ phase, down: downs[index]! })));
  const built: BuiltWeek[] = [];
  let previousNonDownM: number | null = null;
  phases.forEach((phase, index) => {
    const number = index + 1;
    const down = downs[index]!;
    const targetM = down
      ? weekTargetM({
          kind: "down",
          curveM: curve[index]!,
          previousWeekM: built.at(-1)!.week.distanceM,
        })
      : weekTargetM({
          kind: "climb",
          curveM: curve[index]!,
          previousNonDownWeekM: previousNonDownM,
        });
    const weekStart = addDays(startDate, 7 * index);
    const caps = weekRunCaps(ctx, {
      runCapM: maxRunM(longestInWindowM({ longestByWeekM: built.map((w) => w.longestM), seedM })),
      weekStart,
      longRunsBeforeM: built.flatMap((w) =>
        w.week.sessions.filter((s) => s.type === "long").map((s) => s.target.distanceM),
      ),
      seedM,
    });
    const week = buildTrainingWeek(ctx, {
      number,
      phase,
      weekStart,
      targetM,
      maxRunM: caps.maxRunM,
      longRun: caps.longRun,
      lastHardDate: built.findLast((w) => w.lastHardDate !== null)?.lastHardDate ?? null,
      fastFinish: finishes[index]!,
    });
    if (!down) previousNonDownM = week.week.distanceM;
    built.push(week);
  });
  return built;
}

/** Everything before the weeks are built, or the first conflict, in the order the runner meets them. */
function setUp(
  rawInput: PlanGenerationInput,
): { ok: true; setup: Setup } | { ok: false; conflict: PlanConflict } {
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
  const training = pacesFromVdot(vdot);
  const race = racePace({
    distanceM: DISTANCE_METERS[distanceKey],
    predictedTimeS,
    targetTimeS: goal.targetTimeS,
    easySlowSPerKm: training.easy.slowSPerKm,
  });
  const paces: PlanPaces = { ...training, race: race.band };
  const easyPaceSPerKm = bandMidpointSPerKm(paces.easy);
  const ctx: PlanContext = {
    distanceKey,
    daysPerWeek: goal.daysPerWeek,
    longRunDay: goal.longRunDay,
    raceDate: goal.raceDate,
    paces,
    easyPaceSPerKm,
    minRunM: minRunDistanceM(easyPaceSPerKm),
    baselineLongestM: baseline.longestRunM,
  };
  const seedM = longestRunSeedM(baseline.longestRunM);
  // Week 1 as a whole week of its phase; a plan that starts in the taper is measured on a taper week.
  const weekOnePhase = PRE_TAPER.includes(length.phases[0]!) ? length.phases[0]! : "taper";
  const start = startVolume({
    baseline,
    distanceKey,
    daysPerWeek: goal.daysPerWeek,
    neededWeeklyM: (daysPerWeek) =>
      neededWeeklyM(
        { ...ctx, daysPerWeek, raceDate: null },
        { phase: weekOnePhase, weekStart: startDate, maxRunM: maxRunM(seedM) },
      ),
  });
  if (!start.ok) return { ok: false, conflict: start.conflict };
  return {
    ok: true,
    setup: {
      ctx,
      startDate,
      phases: length.phases,
      endDate: length.endDate,
      vdot,
      paces,
      seedM,
      start,
      lengthWarning: length.warning,
      raceWarning: race.warning,
    },
  };
}

/**
 * Week 1's volume as generatePlan sets it (rules/baseline.ts), or the conflict that comes before it or
 * instead of it. An input the contract rejects is a programmer error and throws.
 */
export function planStartVolume(input: PlanGenerationInput): StartVolumeResult {
  const result = setUp(input);
  return result.ok ? result.setup.start : result;
}

/**
 * The training plan for a goal: every week from the first Monday to the race (or 12 weeks for a
 * fitness goal), each number from a rule in src/rules. A goal the rules cannot serve at the runner's
 * days and baseline is a conflict, returned rather than bent. Pure: the same input gives the same
 * plan, byte for byte. An input the contract rejects is a programmer error and throws.
 */
export function generatePlan(input: PlanGenerationInput): PlanGenerationResult {
  const result = setUp(input);
  if (!result.ok) return result;
  const { ctx, startDate, phases, endDate, vdot, paces, seedM, start } = result.setup;
  const preTaper = buildPreTaperWeeks(ctx, {
    phases: phases.filter((phase) => PRE_TAPER.includes(phase)),
    startDate,
    startVolumeM: start.startVolumeM,
    seedM,
  });
  const weeks: GeneratedWeek[] =
    ctx.raceDate === null
      ? preTaper.map((built) => built.week)
      : buildTaperWeeks(ctx, {
          phases,
          startDate,
          startVolumeM: start.startVolumeM,
          seedM,
          preTaper,
        });
  // The peak long run is the longest before the taper; the taper's long runs are cut on purpose.
  const preTaperLongRunsM = preTaper
    .flatMap((built) => built.week.sessions)
    .filter((session) => session.type === "long")
    .map((session) => session.target.distanceM);
  const longRunShort =
    preTaperLongRunsM.length === 0
      ? null
      : longRunWarning({
          peakLongRunM: Math.max(...preTaperLongRunsM),
          requiredLongRunM: requiredLongRunM({
            distanceKey: ctx.distanceKey,
            easyPaceSPerKm: ctx.easyPaceSPerKm,
          }),
        });
  return {
    ok: true,
    plan: {
      engineVersion: ENGINE_VERSION,
      startDate,
      endDate,
      vdot,
      paces,
      warnings: [
        result.setup.lengthWarning,
        start.warning,
        longRunShort,
        result.setup.raceWarning,
      ].filter((warning): warning is PlanWarning => warning !== null),
      weeks,
    },
  };
}
