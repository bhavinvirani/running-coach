import {
  sessionStepsSchema,
  type GeneratedPlan,
  type PlanDelta,
  type PlanGenerationInput,
  type SessionStatus,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, weekdayIndex, weekdayOf } from "../dates";
import { validateDelta, type DeltaContext } from "../rules/delta";
import { reEntryPlan, type ReEntryInput, type ReEntrySession } from "../rules/re-entry-plan";
import { bandMidpointSPerKm, sessionTarget } from "../rules/session-target";
import { matchSessions, type MatchSession } from "../rules/session-match";
import { validateWeekDeltas, type WeekDeltaSession } from "../rules/week-delta";
import { minRunDistanceM } from "../rules/week-fill";
import { maxWeeklyVolumeM } from "../rules/weekly-volume";
import { generatePlan } from "./generate";
import { planInputArb } from "./plan-arbitraries";

// Slice 9's and 10's rules over whole plans: the coach's deltas after a run and in a weekly review, the
// re-entry after time off and run matching keep the plan's caps on any plan generatePlan makes.

const QUALITY = new Set(["intervals", "tempo", "race_practice"]);
const PROPERTY_TIMEOUT_MS = 120_000;

interface Drawn {
  input: PlanGenerationInput;
  plan: GeneratedPlan;
}

/** Plans generatePlan makes from any input the contract allows; conflicts are dropped. */
const planArb: fc.Arbitrary<Drawn> = planInputArb
  .map((input) => ({ input, result: generatePlan(input) }))
  .filter((drawn) => drawn.result.ok)
  .map(({ input, result }) => ({
    input,
    plan: (result as { ok: true; plan: GeneratedPlan }).plan,
  }));

const sessionsOf = (plan: GeneratedPlan) => plan.weeks.flatMap((week) => week.sessions);
const mondayOf = (date: string) => addDays(date, -weekdayIndex(weekdayOf(date)));

describe("adaptation over generated plans", () => {
  const deltaArb: fc.Arbitrary<PlanDelta> = fc.oneof(
    fc
      .double({ min: 0, max: 2, noNaN: true })
      .map((factor) => ({ kind: "scale" as const, factor })),
    fc.constant({ kind: "easy" as const }),
    fc.constant({ kind: "rest" as const }),
  );

  it(
    "never lets a coach delta break 110% of the recent longest, the long-run share, 150 min or +10% on last week, nor grow a session a re-entry eased or one right after a paused week",
    () => {
      fc.assert(
        fc.property(
          planArb,
          fc.nat(),
          deltaArb,
          fc.nat({ max: 40_000 }),
          fc.nat({ max: 3 }),
          fc.boolean(),
          fc.boolean(),
          ({ input, plan }, pick, delta, longestRecentM, daysBefore, eased, afterPause) => {
            const all = sessionsOf(plan);
            const picked = all[pick % all.length]!;
            const weekIndex = plan.weeks.findIndex((week) => week.sessions.includes(picked));
            const ctx: DeltaContext = {
              today: addDays(picked.date, -daysBefore),
              session: { ...picked, status: "planned", source: "plan", title: null },
              weekSessions: plan.weeks[weekIndex]!.sessions.filter((s) => s !== picked).map(
                (s) => ({ ...s, status: "planned" as const }),
              ),
              previousWeekM: plan.weeks[weekIndex - 1]?.distanceM ?? null,
              longestRecentM,
              daysPerWeek: input.goal.daysPerWeek,
              paces: plan.paces,
              paused: false,
              coachAdjusted: false,
              eased,
              afterPause,
            };
            const result = validateDelta(ctx, delta);
            expect(validateDelta(ctx, delta)).toEqual(result);
            if (picked.type === "race") expect(result).toEqual({ ok: false, reason: "race" });
            if (!result.ok) return;
            expect(sessionStepsSchema.parse(result.session.steps)).toEqual(result.session.steps);
            expect(result.session.target).toEqual(sessionTarget(result.session.steps, plan.paces));
            if (delta.kind === "rest") expect(result.session.status).toBe("skipped");
            if (QUALITY.has(result.session.type)) {
              expect(result.session.target.distanceM).toBeLessThanOrEqual(picked.target.distanceM);
            }
            const newM = result.session.target.distanceM;
            if (newM <= picked.target.distanceM) return;
            const othersM = ctx.weekSessions.reduce((sum, s) => sum + s.target.distanceM, 0);
            expect(eased).toBe(false);
            expect(afterPause).toBe(false);
            expect(newM).toBeLessThanOrEqual(Math.floor(longestRecentM * 1.1));
            if (picked.type === "long") {
              const share = input.goal.daysPerWeek >= 4 ? 0.3 : 0.4;
              expect(newM).toBeLessThanOrEqual(share * (othersM + newM) + 1e-6);
              expect(result.session.target.durationS).toBeLessThanOrEqual(9000);
            }
            if (ctx.previousWeekM !== null) {
              expect(othersM + newM).toBeLessThanOrEqual(Math.floor(ctx.previousWeekM * 1.1));
            }
          },
        ),
        { numRuns: 150 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "keeps a week within +10% of the week before over all of a weekly review's changes together, in any order, and never grows one right after a paused week",
    () => {
      fc.assert(
        fc.property(
          planArb,
          fc.nat(),
          fc.array(
            fc.record({
              pick: fc.noBias(fc.nat({ max: 99 })),
              // Mostly rises, so several land in one week and meet its cap.
              delta: fc.oneof(
                {
                  weight: 3,
                  arbitrary: fc
                    .noBias(fc.double({ min: 1, max: 1.3, noNaN: true }))
                    .map((factor) => ({ kind: "scale" as const, factor })),
                },
                { weight: 1, arbitrary: deltaArb },
              ),
            }),
            { minLength: 1, maxLength: 6 },
          ),
          // The longest recent run as a share of the week's longest session.
          fc.noBias(fc.double({ min: 0.8, max: 1.6, noNaN: true })),
          fc.boolean(),
          ({ input, plan }, weekPick, drawn, longestShare, afterPause) => {
            const weekIndex = weekPick % plan.weeks.length;
            const week = plan.weeks[weekIndex]!;
            if (week.sessions.length === 0) return;
            const sessions: WeekDeltaSession[] = week.sessions.map((s, k) => ({
              ...s,
              id: `s${k}`,
              status: "planned",
              source: "plan",
              title: null,
              coachAdjusted: false,
              eased: false,
            }));
            const proposals = drawn.map(({ pick, delta }) => ({
              sessionId: `s${pick % sessions.length}`,
              delta,
            }));
            const ctx = {
              today: week.startDate,
              sessions,
              previousWeekM: plan.weeks[weekIndex - 1]?.distanceM ?? null,
              longestRecentM: Math.round(
                longestShare * Math.max(...sessions.map((s) => s.target.distanceM)),
              ),
              daysPerWeek: input.goal.daysPerWeek,
              paces: plan.paces,
              paused: false,
              afterPause,
            };
            const outcomes = validateWeekDeltas(ctx, proposals);
            expect(outcomes.map((o) => o.sessionId)).toEqual(proposals.map((p) => p.sessionId));
            if (new Set(proposals.map((p) => p.sessionId)).size === proposals.length) {
              expect(validateWeekDeltas(ctx, [...proposals].reverse())).toEqual(
                [...outcomes].reverse(),
              );
            }
            const afterM = new Map(sessions.map((s) => [s.id, s.target.distanceM]));
            for (const { sessionId, result } of outcomes) {
              if (!result.ok) continue;
              expect(result.session.target).toEqual(
                sessionTarget(result.session.steps, plan.paces),
              );
              afterM.set(
                sessionId!,
                result.session.status === "skipped" ? 0 : result.session.target.distanceM,
              );
            }
            const plannedM = sessions.reduce((sum, s) => sum + s.target.distanceM, 0);
            const totalM = [...afterM.values()].reduce((sum, m) => sum + m, 0);
            if (ctx.previousWeekM !== null && ctx.previousWeekM > 0) {
              expect(totalM).toBeLessThanOrEqual(
                Math.max(plannedM, maxWeeklyVolumeM(ctx.previousWeekM)),
              );
            }
            if (afterPause) expect(totalM).toBeLessThanOrEqual(plannedM);
            for (const s of sessions) {
              if (afterPause || QUALITY.has(s.type)) {
                expect(afterM.get(s.id)!).toBeLessThanOrEqual(s.target.distanceM);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  const reEntryArb = fc
    .record({
      drawn: planArb,
      fromOffset: fc.nat({ max: 400 }),
      daysOff: fc.nat({ max: 30 }),
      walkRun: fc.boolean(),
      carriedFactor: fc.constantFrom(undefined, 0.5, 0.7, 1),
      pastStatuses: fc.array(fc.constantFrom<SessionStatus>("done", "missed", "skipped"), {
        minLength: 400,
        maxLength: 400,
      }),
    })
    .map(({ drawn, fromOffset, daysOff, walkRun, carriedFactor, pastStatuses }) => {
      const days = daysBetween(drawn.plan.startDate, drawn.plan.endDate) + 1;
      const fromDate = addDays(drawn.plan.startDate, fromOffset % days);
      const sessions: ReEntrySession[] = sessionsOf(drawn.plan).map((s, k) => ({
        ...s,
        id: `s${k}`,
        status: daysBetween(fromDate, s.date) < 0 ? pastStatuses[k % 400]! : "planned",
        source: "plan",
        title: null,
      }));
      const reEntry: ReEntryInput = {
        fromDate,
        daysOff,
        walkRun,
        carriedFactor,
        sessions,
        paces: drawn.plan.paces,
      };
      return { plan: drawn.plan, reEntry };
    });

  it(
    "eases a return without touching the race or what came before, each week at most 10% over the one before, never easing one break twice",
    () => {
      fc.assert(
        fc.property(reEntryArb, ({ plan, reEntry }) => {
          const result = reEntryPlan(reEntry);
          expect(reEntryPlan(reEntry)).toEqual(result);
          expect(result.factor).toBeLessThanOrEqual(1);
          const byId = new Map(reEntry.sessions.map((s) => [s.id, s]));
          const minRunM = minRunDistanceM(bandMidpointSPerKm(plan.paces.easy));

          // The spec's targets: week 1 at the factor of its plan, then up 10% a week until a week meets it.
          const plannedM = new Map<string, number>();
          for (const s of reEntry.sessions) {
            const counts = daysBetween(reEntry.fromDate, s.date) < 0 || s.status === "planned";
            const monday = mondayOf(s.date);
            if (counts && daysBetween(mondayOf(reEntry.fromDate), monday) >= 0) {
              plannedM.set(monday, (plannedM.get(monday) ?? 0) + s.target.distanceM);
            }
          }
          const ratios = new Map<string, number>();
          let previousTargetM: number | null = null;
          for (const [monday, weekM] of [...plannedM].sort(([a], [b]) => daysBetween(b, a))) {
            const targetM: number =
              previousTargetM === null
                ? result.factor * weekM
                : Math.min(weekM, previousTargetM * 1.1);
            if (previousTargetM !== null)
              expect(targetM).toBeLessThanOrEqual(previousTargetM * 1.1);
            if (targetM >= weekM) break;
            ratios.set(monday, targetM / weekM);
            previousTargetM = targetM;
          }

          for (const { id, session: after } of result.changes) {
            const before = byId.get(id)!;
            expect(daysBetween(reEntry.fromDate, before.date)).toBeGreaterThanOrEqual(0);
            expect(before.type).not.toBe("race");
            expect(before.status).toBe("planned");
            expect(sessionStepsSchema.parse(after.steps)).toEqual(after.steps);
            const firstDays = daysBetween(reEntry.fromDate, before.date) < 7;
            if (after.title === "Walk-run") {
              expect(reEntry.walkRun && firstDays).toBe(true);
              expect(after.target.durationS).toBeLessThanOrEqual(
                Math.max(before.target.durationS, 1200),
              );
              continue;
            }
            expect(after.target.distanceM).toBeLessThanOrEqual(before.target.distanceM);
            if (firstDays && result.factor < 1) expect(QUALITY.has(after.type)).toBe(false);
            const ratio = ratios.get(mondayOf(before.date));
            if (!QUALITY.has(before.type) && ratio !== undefined) {
              expect(after.target.distanceM).toBeLessThanOrEqual(
                Math.max(
                  ratio * before.target.distanceM + 1e-6,
                  Math.min(before.target.distanceM, minRunM),
                ),
              );
              expect(after.target.distanceM).toBeGreaterThanOrEqual(
                Math.min(before.target.distanceM, minRunM),
              );
            }
          }
          // Weeks that meet their plan, outside the first 7 days, run as planned.
          for (const s of reEntry.sessions) {
            const firstDays =
              daysBetween(reEntry.fromDate, s.date) >= 0 &&
              daysBetween(reEntry.fromDate, s.date) < 7;
            if (!firstDays && !ratios.has(mondayOf(s.date))) {
              expect(result.changes.map((c) => c.id)).not.toContain(s.id);
            }
          }
        }),
        { numRuns: 150 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "matches runs to a plan's sessions without moving a missed session, idempotently",
    () => {
      fc.assert(
        fc.property(
          planArb,
          fc.nat({ max: 400 }),
          fc.array(fc.record({ day: fc.nat({ max: 400 }), distanceM: fc.nat({ max: 30_000 }) }), {
            maxLength: 40,
          }),
          ({ plan }, todayOffset, drawnRuns) => {
            const days = daysBetween(plan.startDate, plan.endDate) + 1;
            const today = addDays(plan.startDate, todayOffset % days);
            const sessions: MatchSession[] = sessionsOf(plan).map((s, k) => ({
              id: `s${k}`,
              date: s.date,
              status: "planned",
              distanceM: s.target.distanceM,
              activityId: null,
            }));
            const runs = drawnRuns.map((r, k) => ({
              id: `r${k}`,
              date: addDays(plan.startDate, r.day % days),
              distanceM: r.distanceM,
            }));
            const input = { today, sessions, runs, pausedFrom: null };
            const matches = matchSessions(input);
            const byId = new Map(matches.map((m) => [m.id, m]));
            const after = sessions.map((s) => ({ ...s, ...byId.get(s.id) }));
            expect(matchSessions({ ...input, sessions: after })).toEqual([]);
            for (const s of after) {
              const past = daysBetween(s.date, today) > 0;
              if (past) expect(["done", "missed"]).toContain(s.status);
              if (daysBetween(s.date, today) < 0) expect(s.status).toBe("planned");
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
