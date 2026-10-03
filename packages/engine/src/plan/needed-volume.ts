import type { PlanPhase } from "@running-coach/shared";
import { buildTrainingWeek, type PlanContext } from "./build-week";

export interface NeededWeekInput {
  /** Week 1's phase; a plan that starts in the taper is measured on a taper week. */
  phase: PlanPhase;
  weekStart: string;
  /** 110% of the baseline's longest run. */
  maxRunM: number;
}

const QUALITY_TYPES: ReadonlySet<string> = new Set(["intervals", "tempo", "race_practice"]);
// Each step up while no week holds the days yet; the bisection then finds the edge to the meter.
const SEARCH_GROWTH = 1.25;

/**
 * The smallest week, in whole meters, that holds week 1's sessions as the week builder sizes them: a
 * run on every day asked for, each at least 20 min, every quality session the week lays out and a long
 * run at least as long as the longest of them. The sessions grow with the week (work is a share of it),
 * so there is no closed form: the volume is searched through the builder, upward from 20 min a day,
 * then bisected. A run cap that keeps the quality sessions out at any volume leaves the days alone to
 * hold. Deterministic: the same context gives the same meters.
 */
export function neededWeeklyM(ctx: PlanContext, week: NeededWeekInput): number {
  const holds = (weekVolumeM: number, withQuality: boolean) => {
    const built = buildTrainingWeek(ctx, {
      number: 1,
      phase: week.phase,
      weekStart: week.weekStart,
      targetM: weekVolumeM,
      maxRunM: week.maxRunM,
      lastHardDate: null,
    });
    const { sessions } = built.week;
    return (
      sessions.length === ctx.daysPerWeek &&
      sessions.every((session) => session.target.distanceM >= ctx.minRunM) &&
      (!withQuality ||
        sessions.filter((session) => QUALITY_TYPES.has(session.type)).length ===
          built.slots.quality.length)
    );
  };
  // Under 20 min a day no week holds the days; with every run at its cap, a larger one holds no more.
  const fewestM = ctx.daysPerWeek * ctx.minRunM - 1;
  const mostM = 2 * ctx.daysPerWeek * Math.max(week.maxRunM, ctx.minRunM);
  const smallest = (withQuality: boolean): number | null => {
    let low = fewestM;
    let high = fewestM + 1;
    while (!holds(high, withQuality)) {
      if (high >= mostM) return null;
      low = high;
      high = Math.min(mostM, Math.ceil(high * SEARCH_GROWTH));
    }
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (holds(middle, withQuality)) high = middle;
      else low = middle;
    }
    return high;
  };
  return smallest(true) ?? smallest(false) ?? mostM;
}
