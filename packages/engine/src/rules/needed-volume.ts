import type { PlanPhase, SessionType } from "@running-coach/shared";
import { NEEDED_VOLUME_STEP_M } from "../constants";
import { buildTrainingWeek, type PlanContext } from "../plan/build-week";
import { QUALITY_SESSION_TYPE } from "./quality";

export interface NeededWeekInput {
  /** Week 1's phase; a plan that starts in the taper is measured on a taper week. */
  phase: PlanPhase;
  weekStart: string;
  /** 110% of the baseline's longest run. */
  maxRunM: number;
}

const QUALITY_TYPES: ReadonlySet<SessionType> = new Set(Object.values(QUALITY_SESSION_TYPE));

/**
 * The smallest week, in whole meters, that holds week 1's sessions as the week builder sizes them: a
 * run on every day asked for, each at least 20 min, every quality session the week lays out and a long
 * run at least as long as the longest of them. The sessions grow with the week (work is a share of it)
 * until a rep no longer fits, so the weeks that hold them form windows rather than everything above one
 * edge, and a window can close a few meters after it opens, where the work jumps at a whole 100 m of
 * week. The search climbs from 20 min a day through every whole 100 m and the meter before it, then
 * bisects to the meter between the last week that does not hold them and the first that does. A run
 * cap that keeps the quality sessions out of every week leaves the days alone to hold, which can need
 * less than fewer days with a quality session. Deterministic: the same context gives the same meters.
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
      // A finish is carved out of the long run: it changes no session's meters.
      fastFinish: false,
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
  // Under 20 min a day no week holds the days. No run passes the long run and the long run passes
  // neither the run cap nor, giving way, 20 min, so a week as built holds at most every day at that:
  // a larger one builds the same runs and holds no more.
  const fewestM = ctx.daysPerWeek * ctx.minRunM - 1;
  const mostM = ctx.daysPerWeek * Math.max(week.maxRunM, ctx.minRunM);
  const smallest = (withQuality: boolean): number | null => {
    let notHeldM = fewestM;
    for (let gridM = fewestM + 1; notHeldM < mostM; gridM += NEEDED_VOLUME_STEP_M) {
      const roundM = Math.min(
        mostM,
        Math.ceil(gridM / NEEDED_VOLUME_STEP_M) * NEEDED_VOLUME_STEP_M,
      );
      for (const probeM of [roundM - 1, roundM]) {
        if (probeM <= notHeldM) continue;
        if (!holds(probeM, withQuality)) {
          notHeldM = probeM;
          continue;
        }
        let heldM = probeM;
        while (heldM - notHeldM > 1) {
          const middleM = Math.floor((notHeldM + heldM) / 2);
          if (holds(middleM, withQuality)) heldM = middleM;
          else notHeldM = middleM;
        }
        return heldM;
      }
    }
    return null;
  };
  return smallest(true) ?? smallest(false) ?? mostM;
}
