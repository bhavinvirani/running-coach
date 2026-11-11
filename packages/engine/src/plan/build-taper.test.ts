import type { GeneratedSession, PlanGenerationInput } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween } from "../dates";
import { bandMidpointSPerKm, sessionTarget } from "../rules/session-target";
import { minRunDistanceM } from "../rules/week-fill";
import { buildTaperWeeks } from "./build-taper";
import { finishWeek, type BuiltWeek, type PlanContext } from "./build-week";
import { generatePlan } from "./generate";

const START = "2026-10-05"; // a Monday
const FRIDAY = "2026-10-30"; // the race, in week 4

/** A Friday 5K on 4 days, long runs on Sunday, at the paces of a 45 min 10K. */
function fridayContext(): PlanContext {
  const of: PlanGenerationInput = {
    goal: {
      kind: "race",
      distanceKey: "5k",
      raceDate: FRIDAY,
      targetTimeS: null,
      daysPerWeek: 4,
      longRunDay: "sun",
      recentTime: null,
    },
    startDate: START,
    baseline: {
      weeklyVolumesM: [30_000, 30_000, 30_000, 30_000],
      longestRunM: 12_000,
      daysSinceLastRun: 2,
    },
    vdotSource: { origin: "entered", distanceM: 10_000, timeS: 2700, activityId: null, date: null },
  };
  const result = generatePlan(of);
  if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.conflict)}`);
  const easyPaceSPerKm = bandMidpointSPerKm(result.plan.paces.easy);
  return {
    distanceKey: "5k",
    daysPerWeek: 4,
    longRunDay: "sun",
    raceDate: FRIDAY,
    paces: result.plan.paces,
    easyPaceSPerKm,
    minRunM: minRunDistanceM(easyPaceSPerKm),
    baselineLongestM: 12_000,
  };
}

/** A week before the taper of easy runs, `runsM` by days from its Monday. */
function builtWeek(
  ctx: PlanContext,
  number: number,
  runsM: readonly (readonly [number, number])[],
): BuiltWeek {
  const weekStart = addDays(START, 7 * (number - 1));
  const sessions = runsM.map(([day, distanceM]): GeneratedSession => {
    const steps = [{ kind: "run" as const, zone: "easy" as const, distanceM, durationS: null }];
    return {
      date: addDays(weekStart, day),
      type: "easy",
      target: sessionTarget(steps, ctx.paces),
      steps,
    };
  });
  return {
    ...finishWeek(number, "peak", weekStart, sessions),
    slots: { long: null, quality: [], easy: [] },
  };
}

describe("build taper weeks", () => {
  it("keeps a 20 min run of its own in a taper week the race week's days would fill, shortening their easy days first: 35 min 5 days out runs 20 min beside one at a ceiling of 2 x 20 min, 6000 m alone 1 m under", () => {
    // After a 45 km week and a week of one run, week 3's ceiling is that run; the 6 days before the
    // race hold 40% of 45 km. Its Sunday, 5 days out, is the race week's 35 min (6000 m), which left
    // the ceiling under 20 min (3474 m) and week 3 nothing of its own from 11 to 6 days out.
    const ctx = fridayContext();
    expect(ctx.minRunM).toBe(3474);
    const taperWeek = (weekTwoM: number) =>
      buildTaperWeeks(ctx, {
        phases: ["peak", "peak", "taper", "race"],
        startDate: START,
        startVolumeM: 30_000,
        seedM: 12_000,
        preTaper: [
          builtWeek(ctx, 1, [
            [0, 11_000],
            [2, 11_000],
            [4, 11_000],
            [6, 12_000],
          ]),
          builtWeek(ctx, 2, [[0, weekTwoM]]),
        ],
      })[2]!.sessions.map((s) => [daysBetween(s.date, FRIDAY), s.type, s.target.distanceM]);
    // One run of its own, 7 to 11 days out, and 5 days out at 20 min.
    const week = taperWeek(2 * ctx.minRunM);
    expect(week.filter(([daysOut]) => (daysOut as number) > 6)).toHaveLength(1);
    expect(week.map(([, type, meters]) => [type, meters])).toEqual([
      ["easy", 3474],
      ["easy", 3474],
    ]);
    expect(week.at(-1)).toEqual([5, "easy", 3474]);
    expect(taperWeek(2 * ctx.minRunM - 1)).toEqual([[5, "easy", 6000]]);
  });
});
