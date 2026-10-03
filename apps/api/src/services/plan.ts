import {
  BASELINE_WEEKS,
  BEST_EFFORT_LOOKBACK_DAYS,
  BEST_EFFORT_MIN_DISTANCE_M,
  generatePlan,
  LONGEST_RUN_LOOKBACK_DAYS,
  RACE_LOOKBACK_DAYS,
  vdotFromPerformance,
} from "@running-coach/engine";
import {
  DISTANCE_METERS,
  distanceKeySchema,
  type Goal,
  type GoalInput,
  type Plan,
  type PlanBaseline,
  type PlanGenerationInput,
  type PlanPhase,
  type PlanResponse,
  type PlanSession,
  type PlanWeek,
  paceSecondsPerUnit,
  RECENT_TIME_PACE_S_PER_KM,
  type RecentTime,
  type SaveGoalResponse,
  type VdotSource,
} from "@running-coach/shared";
import { and, asc, desc, eq, gte, inArray, lt, max, sql } from "drizzle-orm";
import { type Db, type DbTransaction, db } from "../db/client";
import {
  activity,
  bestEffort,
  goal,
  type GoalRow,
  plan,
  type PlanRow,
  planSession,
  type PlanSessionRow,
  userSettings,
} from "../db/schema";
import { addDays, daysBetween, localDateOf, mondayOf } from "../lib/local-date";
import { counted } from "./best-efforts";

// The goal and its plans (SPEC: Plan engine). Saving the goal measures the runner (VDOT source and
// baseline, in the runner's time zone), asks the engine for a plan and stores it as the next version;
// the previous version is kept, superseded, with its sessions and their run links. A conflict saves
// nothing and is answered as data.

// The lookback windows and the best-effort minimum are the engine's (SPEC: Plan engine).

/** A recorded race shorter than this is a time trial on the track or a mis-tagged run. */
const RACE_MIN_DISTANCE_M = DISTANCE_METERS["1k"];
const BEST_EFFORT_KEYS = distanceKeySchema.options.filter(
  (key) => DISTANCE_METERS[key] >= BEST_EFFORT_MIN_DISTANCE_M,
);

/** A run's own wall-clock date: the day the runner lived, whatever zone the run was in. */
const runDate = sql<string>`to_char(${activity.startLocal}, 'YYYY-MM-DD')`;

/** Runs whose local date is in [from, to]. start_local is a timestamp without zone, so no zone math. */
function runDateWithin(from: string, to: string) {
  return and(
    gte(activity.startLocal, `${from} 00:00:00`),
    lt(activity.startLocal, `${addDays(to, 1)} 00:00:00`),
  );
}

/** The last `days` local dates, today included. */
function lastDays(today: string, days: number): [from: string, to: string] {
  return [addDays(today, 1 - days), today];
}

/** The plan's first Monday: today on a Monday, else the next one (planGenerationInputSchema). */
function firstMonday(today: string): string {
  const monday = mondayOf(today);
  return monday === today ? today : addDays(monday, 7);
}

async function timezoneOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  // requireUser found the user, and its settings row is created with it.
  if (!row) throw new Error("The signed-in user has no settings row");
  return row.timezone;
}

/**
 * What the runner has been doing up to today. Manual runs stay out of the volume and the longest run,
 * since a typed-in distance is not a measured one, but count for the days since the last run: the
 * runner did run. Indoor runs count, since a treadmill week is still a week of running.
 */
async function readBaseline(userId: string, today: string): Promise<PlanBaseline> {
  const firstWeek = addDays(mondayOf(today), -7 * BASELINE_WEEKS);
  const [longestFrom] = lastDays(today, LONGEST_RUN_LOOKBACK_DAYS);
  const from = longestFrom < firstWeek ? longestFrom : firstWeek;
  const measured = and(eq(activity.userId, userId), eq(activity.isManual, false));
  const runs = await db
    .select({ date: runDate, distanceM: activity.distanceM })
    .from(activity)
    .where(and(measured, runDateWithin(from, today)));
  const weeklyVolumesM = Array.from({ length: BASELINE_WEEKS }, () => 0);
  let longestRunM = 0;
  for (const run of runs) {
    const week = Math.floor(daysBetween(firstWeek, run.date) / 7);
    if (week >= 0 && week < BASELINE_WEEKS) weeklyVolumesM[week]! += run.distanceM;
    if (daysBetween(run.date, today) < LONGEST_RUN_LOOKBACK_DAYS) {
      longestRunM = Math.max(longestRunM, run.distanceM);
    }
  }
  // A run whose local date is after today (it was in a zone ahead of the runner's) is not the last run.
  const [last] = await db
    .select({ date: sql<string | null>`to_char(max(${activity.startLocal}), 'YYYY-MM-DD')` })
    .from(activity)
    .where(
      and(eq(activity.userId, userId), lt(activity.startLocal, `${addDays(today, 1)} 00:00:00`)),
    );
  const lastDate = last?.date ?? null;
  return {
    weeklyVolumesM: weeklyVolumesM.map(Math.round),
    longestRunM: Math.round(longestRunM),
    daysSinceLastRun: lastDate === null ? null : daysBetween(lastDate, today),
  };
}

/**
 * A recorded performance at a pace an entered time may have (recentTimeSchema): a walk tagged as a race
 * or a GPS jump inside a best effort would otherwise set every pace of the plan.
 */
function plausible({ distanceM, timeS }: VdotSource): boolean {
  const sPerKm = paceSecondsPerUnit(distanceM, timeS, "km");
  return (
    sPerKm !== null &&
    sPerKm >= RECENT_TIME_PACE_S_PER_KM.fastest &&
    sPerKm <= RECENT_TIME_PACE_S_PER_KM.slowest
  );
}

/**
 * The plausible candidate with the highest VDOT; on a tie the first, so callers list the newest first.
 * Every pace inside the bounds gives a positive VDOT, so the engine never throws here.
 */
function fittest(sources: VdotSource[]): VdotSource | null {
  let best: { source: VdotSource; vdot: number } | null = null;
  for (const source of sources.filter(plausible)) {
    const vdot = vdotFromPerformance(source);
    if (best === null || vdot > best.vdot) best = { source, vdot };
  }
  return best?.source ?? null;
}

/** The contract keeps an entered time inside the plausible paces, so it is always a source. */
function enteredSource({ distanceKey, timeS }: RecentTime): VdotSource {
  return {
    origin: "entered",
    distanceM: DISTANCE_METERS[distanceKey],
    timeS,
    activityId: null,
    date: null,
  };
}

/** The fastest recorded race of the last 180 days by VDOT, each over its own distance and time. */
async function recordedRace(userId: string, today: string): Promise<VdotSource | null> {
  const races = await db
    .select({
      id: activity.id,
      date: runDate,
      distanceM: activity.distanceM,
      durationS: activity.durationS,
    })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        eq(activity.eventType, "race"),
        eq(activity.isManual, false),
        gte(activity.distanceM, RACE_MIN_DISTANCE_M),
        runDateWithin(...lastDays(today, RACE_LOOKBACK_DAYS)),
      ),
    )
    .orderBy(desc(activity.startLocal), asc(activity.id));
  return fittest(
    races.map((race) => ({
      origin: "race",
      // Whole meters and seconds, like every other distance and time the plan carries.
      distanceM: Math.round(race.distanceM),
      timeS: Math.round(race.durationS),
      activityId: race.id,
      date: race.date,
    })),
  );
}

/** The fastest best effort of 5 km or more in the last 90 days, by VDOT, from runs that still count. */
async function recentBestEffort(userId: string, today: string): Promise<VdotSource | null> {
  const efforts = await db
    .select({
      activityId: activity.id,
      date: runDate,
      distanceKey: bestEffort.distanceKey,
      timeS: bestEffort.timeS,
    })
    .from(bestEffort)
    .innerJoin(activity, eq(activity.id, bestEffort.activityId))
    .where(
      and(
        eq(bestEffort.userId, userId),
        counted,
        inArray(bestEffort.distanceKey, BEST_EFFORT_KEYS),
        runDateWithin(...lastDays(today, BEST_EFFORT_LOOKBACK_DAYS)),
      ),
    )
    .orderBy(desc(activity.startLocal), asc(bestEffort.id));
  return fittest(
    efforts.map((effort) => ({
      origin: "best_effort",
      distanceM: DISTANCE_METERS[effort.distanceKey],
      timeS: Math.round(effort.timeS),
      activityId: effort.activityId,
      date: effort.date,
    })),
  );
}

/** What the paces come from: an entered time, else a recorded race, else a best effort, else nothing. */
async function vdotSourceFor(
  userId: string,
  recentTime: RecentTime | null,
  today: string,
): Promise<VdotSource | null> {
  if (recentTime !== null) return enteredSource(recentTime);
  return (await recordedRace(userId, today)) ?? recentBestEffort(userId, today);
}

function goalColumns(input: GoalInput) {
  return {
    kind: input.kind,
    distanceKey: input.distanceKey,
    raceDate: input.raceDate,
    targetTimeS: input.targetTimeS,
    daysPerWeek: input.daysPerWeek,
    longRunDay: input.longRunDay,
    recentDistanceKey: input.recentTime?.distanceKey ?? null,
    recentTimeS: input.recentTime?.timeS ?? null,
  };
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    kind: row.kind,
    distanceKey: row.distanceKey,
    raceDate: row.raceDate,
    targetTimeS: row.targetTimeS,
    daysPerWeek: row.daysPerWeek,
    longRunDay: row.longRunDay,
    recentTime:
      row.recentDistanceKey === null || row.recentTimeS === null
        ? null
        : { distanceKey: row.recentDistanceKey, timeS: row.recentTimeS },
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSession(row: PlanSessionRow): PlanSession {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    target: row.target,
    steps: row.steps,
    status: row.status,
    activityId: row.activityId,
  };
}

/**
 * The plan's weeks rebuilt from its sessions: consecutive Mondays from the start date to the end date,
 * each with its sessions' phase. The engine gives every week sessions; a week left without any (once
 * sessions can move) takes the phase of the week before it, or after it for the first week, since the
 * engine sets phases in runs of whole weeks.
 */
function toWeeks(row: PlanRow, sessions: PlanSessionRow[]): PlanWeek[] {
  const count = Math.floor(daysBetween(row.startDate, row.endDate) / 7) + 1;
  const weeks = Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    startDate: addDays(row.startDate, 7 * index),
    phase: null as PlanPhase | null,
    distanceM: 0,
    sessions: [] as PlanSession[],
  }));
  for (const session of sessions) {
    const week = weeks[Math.floor(daysBetween(row.startDate, session.date) / 7)];
    if (!week) throw new Error(`Plan ${row.id} has a session outside its weeks`);
    week.phase ??= session.phase;
    week.distanceM += session.target.distanceM;
    week.sessions.push(toSession(session));
  }
  return weeks.map((week, index) => {
    const phase =
      week.phase ??
      weeks.findLast((other, at) => at < index && other.phase !== null)?.phase ??
      weeks.find((other) => other.phase !== null)?.phase;
    if (!phase) throw new Error(`Plan ${row.id} has no sessions`);
    return { ...week, phase };
  });
}

async function loadPlan(executor: Db | DbTransaction, row: PlanRow): Promise<Plan> {
  const sessions = await executor
    .select()
    .from(planSession)
    .where(eq(planSession.planId, row.id))
    .orderBy(asc(planSession.date), asc(planSession.id));
  return {
    id: row.id,
    goalId: row.goalId,
    version: row.version,
    engineVersion: row.engineVersion,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    vdot: row.vdot,
    vdotSource: row.vdotSource,
    paces: row.paces,
    warnings: row.warnings,
    weeks: toWeeks(row, sessions),
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /api/plan: the goal and its active plan, both null until a goal is saved. */
export async function getPlan(userId: string): Promise<PlanResponse> {
  const [goalRow] = await db.select().from(goal).where(eq(goal.userId, userId));
  if (!goalRow) return { goal: null, plan: null };
  const [planRow] = await db
    .select()
    .from(plan)
    .where(and(eq(plan.goalId, goalRow.id), eq(plan.status, "active")));
  return { goal: toGoal(goalRow), plan: planRow ? await loadPlan(db, planRow) : null };
}

/**
 * PUT /api/goal: generates a plan from the goal starting on the first Monday from today in the runner's
 * time zone. On a conflict nothing is written. Otherwise the goal is saved and the plan becomes the
 * goal's next version, the previous one superseded with its sessions kept. `now` is the request's
 * instant; tests pass their own.
 */
export async function saveGoal(
  userId: string,
  input: GoalInput,
  now = new Date(),
): Promise<SaveGoalResponse> {
  const today = localDateOf(now, await timezoneOf(userId));
  const inputs: PlanGenerationInput = {
    goal: input,
    startDate: firstMonday(today),
    baseline: await readBaseline(userId, today),
    vdotSource: await vdotSourceFor(userId, input.recentTime, today),
  };
  const result = generatePlan(inputs);
  if (!result.ok) return result;
  const generated = result.plan;
  // generatePlan answers no_recent_time before anything else without a source.
  const vdotSource = inputs.vdotSource!;

  return db.transaction(async (tx) => {
    // The upsert comes first: it locks the user's goal row, so a second save for the user waits here
    // and then supersedes this plan instead of racing it for the version and the active slot.
    const [goalRow] = await tx
      .insert(goal)
      .values({ userId, ...goalColumns(input) })
      .onConflictDoUpdate({
        target: goal.userId,
        set: { ...goalColumns(input), updatedAt: sql`now()` },
      })
      .returning();
    if (!goalRow) throw new Error("The goal upsert returned nothing");
    await tx
      .update(plan)
      .set({ status: "superseded" })
      .where(and(eq(plan.goalId, goalRow.id), eq(plan.status, "active")));
    const [latest] = await tx
      .select({ version: max(plan.version) })
      .from(plan)
      .where(eq(plan.goalId, goalRow.id));
    const [planRow] = await tx
      .insert(plan)
      .values({
        goalId: goalRow.id,
        userId,
        version: (latest?.version ?? 0) + 1,
        engineVersion: generated.engineVersion,
        status: "active",
        startDate: generated.startDate,
        endDate: generated.endDate,
        vdot: generated.vdot,
        vdotSource,
        paces: generated.paces,
        inputs,
        warnings: generated.warnings,
      })
      .returning();
    if (!planRow) throw new Error("The plan insert returned nothing");
    await tx.insert(planSession).values(
      generated.weeks.flatMap((week) =>
        week.sessions.map((session) => ({
          planId: planRow.id,
          userId,
          date: session.date,
          type: session.type,
          phase: week.phase,
          target: session.target,
          steps: session.steps,
        })),
      ),
    );
    return { ok: true as const, goal: toGoal(goalRow), plan: await loadPlan(tx, planRow) };
  });
}
