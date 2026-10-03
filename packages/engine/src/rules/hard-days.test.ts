import { sessionTypeSchema, weekdaySchema, type SessionType } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, weekdayIndex } from "../dates";
import { generatePlan } from "../plan/generate";
import { planInputArb } from "../plan/plan-arbitraries";
import { hardSessionTooClose, isSpacedFromHardDay, weekLayout } from "./hard-days";

// The oracle, written out here rather than read from the engine's constant.
const HARD = new Set<SessionType>(["long", "intervals", "tempo", "race_practice", "race"]);
const DAY = "2026-10-07"; // a Wednesday

describe("hard days", () => {
  it("puts two quality sessions 2 and 4 days after a Sunday long run, inside the week", () => {
    expect(
      weekLayout({ longRunDay: "sun", daysPerWeek: 4, qualityCount: 2, lastHardDaysBefore: null }),
    ).toEqual({
      longRun: "sun",
      quality: ["tue", "thu"],
      easy: ["wed"],
    });
  });

  it("puts two quality sessions on Monday and Wednesday around a Saturday long run", () => {
    expect(
      weekLayout({ longRunDay: "sat", daysPerWeek: 4, qualityCount: 2, lastHardDaysBefore: 2 })
        .quality,
    ).toEqual(["mon", "wed"]);
  });

  it("puts one quality session 3 days after the long run", () => {
    expect(
      weekLayout({ longRunDay: "mon", daysPerWeek: 3, qualityCount: 1, lastHardDaysBefore: 3 }),
    ).toEqual({
      longRun: "mon",
      quality: ["thu"],
      easy: ["sat"],
    });
  });

  it("fills easy days 3, 5, 1 and 6 days after the long run, then the free days left", () => {
    expect(
      weekLayout({ longRunDay: "sun", daysPerWeek: 6, qualityCount: 2, lastHardDaysBefore: 1 })
        .easy,
    ).toEqual(["wed", "fri", "mon"]);
    expect(
      weekLayout({ longRunDay: "sun", daysPerWeek: 6, qualityCount: 1, lastHardDaysBefore: 1 })
        .easy,
    ).toEqual(["fri", "mon", "sat", "tue"]);
    expect(
      weekLayout({ longRunDay: "sun", daysPerWeek: 5, qualityCount: 0, lastHardDaysBefore: 1 })
        .easy,
    ).toEqual(["wed", "fri", "mon", "sat"]);
  });

  it.each([
    [3, 3],
    [2, 2],
    [8, 1],
    [4, -1],
    [4, 1.5],
  ])(
    "rejects %s days with %s quality sessions as a programmer error",
    (daysPerWeek, qualityCount) => {
      expect(() =>
        weekLayout({ longRunDay: "sun", daysPerWeek, qualityCount, lastHardDaysBefore: null }),
      ).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5])(
    "rejects a last hard day %s days before Monday as a programmer error",
    (days) => {
      expect(() =>
        weekLayout({
          longRunDay: "sun",
          daysPerWeek: 4,
          qualityCount: 1,
          lastHardDaysBefore: days,
        }),
      ).toThrow(RangeError);
    },
  );

  it("moves a Monday session a day later after a hard Sunday: Friday long run, 2 sessions then 1", () => {
    // Last week's L+2 was Sunday; this week's lone L+3 would be the Monday after it.
    expect(
      weekLayout({ longRunDay: "fri", daysPerWeek: 4, qualityCount: 1, lastHardDaysBefore: 1 }),
    ).toEqual({
      longRun: "fri",
      quality: ["tue"],
      easy: ["mon", "wed"],
    });
  });

  it("moves a Monday session a day later after a hard Sunday: Thursday long run, 1 session then 2", () => {
    // Last week's L+3 was Sunday; this week's L+4 would be the Monday after it.
    expect(
      weekLayout({ longRunDay: "thu", daysPerWeek: 5, qualityCount: 2, lastHardDaysBefore: 1 }),
    ).toEqual({
      longRun: "thu",
      quality: ["sat", "tue"],
      easy: ["sun", "fri"],
    });
  });

  it("keeps the Monday session when the last hard day was Saturday", () => {
    expect(
      weekLayout({ longRunDay: "fri", daysPerWeek: 4, qualityCount: 1, lastHardDaysBefore: 2 })
        .quality,
    ).toEqual(["mon"]);
  });

  it("spaces a hard day 2 days from the last one, not 1", () => {
    expect(isSpacedFromHardDay({ lastHardDate: "2026-10-04", date: "2026-10-06" })).toBe(true);
    expect(isSpacedFromHardDay({ lastHardDate: "2026-10-04", date: "2026-10-05" })).toBe(false);
    expect(isSpacedFromHardDay({ lastHardDate: null, date: "2026-10-05" })).toBe(true);
  });

  it("keeps every pair of hard days 2 days apart over any run of weeks, on distinct days", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...weekdaySchema.options),
        fc.integer({ min: 3, max: 6 }),
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 8 }),
        (longRunDay, daysPerWeek, counts) => {
          const hard: number[] = [];
          counts.forEach((wanted, week) => {
            const qualityCount = Math.min(wanted, daysPerWeek - 1);
            const last = hard.at(-1);
            const layout = weekLayout({
              longRunDay,
              daysPerWeek,
              qualityCount,
              lastHardDaysBefore: last === undefined ? null : 7 * week - last,
            });
            const days = [layout.longRun, ...layout.quality, ...layout.easy];
            expect(layout.quality).toHaveLength(qualityCount);
            expect(new Set(days).size).toBe(days.length);
            expect(days).toHaveLength(daysPerWeek);
            hard.push(
              ...[layout.longRun, ...layout.quality]
                .map((day) => 7 * week + weekdayIndex(day))
                .sort((a, b) => a - b),
            );
          });
          const sorted = [...hard].sort((a, b) => a - b);
          expect(sorted).toEqual(hard);
          sorted.slice(1).forEach((day, k) => expect(day - sorted[k]!).toBeGreaterThanOrEqual(2));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("hard session too close", () => {
  it.each([
    ["the day before", -1],
    ["the day after", 1],
    ["the same day", 0],
  ])("reports a hard session %s", (_label, offset) => {
    expect(
      hardSessionTooClose({
        type: "intervals",
        date: DAY,
        others: [{ type: "long", date: addDays(DAY, offset) }],
      }),
    ).toEqual({ type: "long", date: addDays(DAY, offset) });
  });

  it.each([-2, 2])("passes a hard session %s days away: exactly 48 h", (offset) => {
    expect(
      hardSessionTooClose({
        type: "tempo",
        date: DAY,
        others: [{ type: "race", date: addDays(DAY, offset) }],
      }),
    ).toBeNull();
  });

  it.each(["easy", "strength", "rest"] as const)(
    "never warns when the session moved is %s, beside hard days",
    (type) => {
      expect(
        hardSessionTooClose({
          type,
          date: DAY,
          others: [
            { type: "long", date: addDays(DAY, -1) },
            { type: "intervals", date: DAY },
            { type: "tempo", date: addDays(DAY, 1) },
          ],
        }),
      ).toBeNull();
    },
  );

  it("ignores easy, strength and rest neighbours", () => {
    expect(
      hardSessionTooClose({
        type: "long",
        date: DAY,
        others: [
          { type: "easy", date: addDays(DAY, -1) },
          { type: "strength", date: DAY },
          { type: "rest", date: addDays(DAY, 1) },
        ],
      }),
    ).toBeNull();
  });

  it("names the nearest hard session, then the earlier one on a tie", () => {
    expect(
      hardSessionTooClose({
        type: "intervals",
        date: DAY,
        others: [
          { type: "tempo", date: addDays(DAY, 1) },
          { type: "race_practice", date: DAY },
          { type: "long", date: addDays(DAY, -1) },
        ],
      }),
    ).toEqual({ type: "race_practice", date: DAY });
    expect(
      hardSessionTooClose({
        type: "intervals",
        date: DAY,
        others: [
          { type: "tempo", date: addDays(DAY, 1) },
          { type: "long", date: addDays(DAY, -1) },
        ],
      }),
    ).toEqual({ type: "long", date: addDays(DAY, -1) });
    expect(
      hardSessionTooClose({
        type: "intervals",
        date: DAY,
        others: [
          { type: "long", date: addDays(DAY, -1) },
          { type: "tempo", date: addDays(DAY, 1) },
        ],
      }),
    ).toEqual({ type: "long", date: addDays(DAY, -1) });
  });

  it("answers no hard session when there are no others", () => {
    expect(hardSessionTooClose({ type: "race", date: DAY, others: [] })).toBeNull();
  });

  it("agrees with the 48 h rule: conflict exactly when a hard session is nearer than 2 days", () => {
    const othersArb = fc.array(
      fc.record({
        type: fc.constantFrom(...sessionTypeSchema.options),
        date: fc.integer({ min: -4, max: 4 }).map((offset) => addDays(DAY, offset)),
      }),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(fc.constantFrom(...sessionTypeSchema.options), othersArb, (type, others) => {
        const gap = (date: string) => Math.abs(daysBetween(DAY, date));
        const close = others.filter((other) => HARD.has(other.type) && gap(other.date) < 2);
        const found = hardSessionTooClose({ type, date: DAY, others });
        if (!HARD.has(type) || close.length === 0) {
          expect(found).toBeNull();
          return;
        }
        expect(found).not.toBeNull();
        expect(close).toContainEqual(found);
        for (const other of close) {
          expect(gap(found!.date)).toBeLessThanOrEqual(gap(other.date));
          if (gap(other.date) === gap(found!.date)) {
            expect(daysBetween(found!.date, other.date)).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("finds nothing too close in any generated plan: the move check and the generator agree", () => {
    fc.assert(
      fc.property(planInputArb, (of) => {
        const result = generatePlan(of);
        fc.pre(result.ok);
        if (!result.ok) return;
        const sessions = result.plan.weeks.flatMap((week) => week.sessions);
        // Sessions are in date order: the 3 on each side hold every session within a day of this one.
        sessions.forEach((session, k) => {
          const others = [
            ...sessions.slice(Math.max(0, k - 3), k),
            ...sessions.slice(k + 1, k + 4),
          ];
          expect(hardSessionTooClose({ ...session, others })).toBeNull();
        });
      }),
      { numRuns: 60 },
    );
  }, 120_000);
});
