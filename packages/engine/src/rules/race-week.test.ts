import {
  generatedSessionSchema,
  raceDistanceKeySchema,
  type GeneratedSession,
  type PlanPaces,
  type Step,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, weekdayIndex, weekdayOf } from "../dates";
import { hardShareHolds, hardTimeS } from "./easy-share";
import { workCapM } from "./quality";
import { raceWeekDays, raceWeekSessions, type RaceWeekDay } from "./race-week";
import { isRaceBandWeek } from "./taper-share";
import { pacesFromVdot } from "./vdot";

const SUNDAY = "2026-10-11"; // the race; its week runs Monday 10-05 to Sunday 10-11
const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // 320 s/km: 20 min 3750 m, 30 min 5500 m, 35 min 6500 m
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 },
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 224 }, // 4 strides and their jogs: 1116 m
  race: { fastSPerKm: 236, slowSPerKm: 244 }, // 240 s/km
};
const OPEN = 1_000_000; // a cap that never binds
const mondayOf = (date: string) => addDays(date, -weekdayIndex(weekdayOf(date)));
const out = (raceDate: string, daysOut: number) => addDays(raceDate, -daysOut);
const day = (raceDate: string, daysOut: number, kind: RaceWeekDay["kind"]): RaceWeekDay => ({
  date: out(raceDate, daysOut),
  daysOut,
  kind,
});
const plain = (distanceM: number): Step[] => [
  { kind: "run", zone: "easy", distanceM, durationS: null },
];
const sumM = (sessions: readonly GeneratedSession[]) =>
  sessions.reduce((sum, session) => sum + session.target.distanceM, 0);
const brief = (sessions: readonly GeneratedSession[]) =>
  sessions.map((session) => [session.date, session.type, session.target.distanceM]);

/** Race practice of `reps` x `repM` at race pace, a 2 min jog after each of 2 or more, 15 min warm-up, 10 min cool-down. */
function practiceM(reps: number, repM: number): number {
  return 2813 + reps * repM + (reps === 1 ? 0 : reps * 375) + 1875;
}

describe("race week days", () => {
  it("picks race practice 4 days out, the primer 2 days out, then 35 min 5 days out: a Sunday race on 4 days", () => {
    expect(
      raceWeekDays({
        raceDate: SUNDAY,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(SUNDAY, 7),
        laidOutDates: [],
      }),
    ).toEqual([day(SUNDAY, 4, "practice"), day(SUNDAY, 2, "primer"), day(SUNDAY, 5, "easy")]);
  });

  it("fills 6 days in the order 4, 2, 5, 3, 6 days out and rests the day before the race", () => {
    expect(
      raceWeekDays({
        raceDate: SUNDAY,
        startDate: "2026-08-03",
        daysPerWeek: 6,
        lastHardDate: out(SUNDAY, 7),
        laidOutDates: [],
      }).map((d) => d.daysOut),
    ).toEqual([4, 2, 5, 3, 6]);
  });

  it("keeps 3 days to race practice and the primer", () => {
    expect(
      raceWeekDays({
        raceDate: SUNDAY,
        startDate: "2026-08-03",
        daysPerWeek: 3,
        lastHardDate: null,
        laidOutDates: [],
      }),
    ).toEqual([day(SUNDAY, 4, "practice"), day(SUNDAY, 2, "primer")]);
  });

  it("moves race practice to 3 days out when 4 days out is under 48 h after the last hard day", () => {
    expect(
      raceWeekDays({
        raceDate: SUNDAY,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(SUNDAY, 5),
        laidOutDates: [],
      }),
    ).toEqual([day(SUNDAY, 3, "practice"), day(SUNDAY, 2, "primer"), day(SUNDAY, 5, "easy")]);
  });

  it("holds no race practice when 3 days out is under 48 h after the last hard day too", () => {
    expect(
      raceWeekDays({
        raceDate: SUNDAY,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(SUNDAY, 4),
        laidOutDates: [],
      }),
    ).toEqual([day(SUNDAY, 2, "primer"), day(SUNDAY, 5, "easy"), day(SUNDAY, 3, "easy")]);
  });

  it("moves race practice to 3 days out when the plan starts after 4 days out, and runs nothing before the start", () => {
    const thursday = "2026-10-08";
    expect(
      raceWeekDays({
        raceDate: thursday,
        startDate: "2026-10-05",
        daysPerWeek: 4,
        lastHardDate: null,
        laidOutDates: [],
      }),
    ).toEqual([day(thursday, 3, "practice"), day(thursday, 2, "primer")]);
  });

  it("runs nothing before a race on the plan's first Tuesday: the Monday is the day before", () => {
    expect(
      raceWeekDays({
        raceDate: "2026-10-06",
        startDate: "2026-10-05",
        daysPerWeek: 6,
        lastHardDate: null,
        laidOutDates: [],
      }),
    ).toEqual([]);
  });

  it("keeps each calendar week to the days asked for: a Thursday race whose week before runs 3 days of its own", () => {
    const thursday = "2026-10-15";
    expect(
      raceWeekDays({
        raceDate: thursday,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(thursday, 7),
        // Tuesday to Thursday of the week before: 9, 8 and 7 days out.
        laidOutDates: [out(thursday, 9), out(thursday, 8), out(thursday, 7)],
      }),
    ).toEqual([day(thursday, 4, "practice"), day(thursday, 2, "primer"), day(thursday, 3, "easy")]);
  });

  it("moves race practice to 3 days out when the week holding 4 days out already runs every day asked for", () => {
    const thursday = "2026-10-15";
    expect(
      raceWeekDays({
        raceDate: thursday,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(thursday, 7),
        // Monday to Thursday of the week before: 10 to 7 days out.
        laidOutDates: [10, 9, 8, 7].map((d) => out(thursday, d)),
      }),
    ).toEqual([day(thursday, 3, "practice"), day(thursday, 2, "primer")]);
  });

  it("leaves a long run 6 days out its day: a Saturday race after a Sunday long run", () => {
    const saturday = "2026-10-10";
    expect(
      raceWeekDays({
        raceDate: saturday,
        startDate: "2026-08-03",
        daysPerWeek: 6,
        lastHardDate: out(saturday, 6),
        laidOutDates: [out(saturday, 6)],
      }).map((d) => d.daysOut),
    ).toEqual([4, 2, 5, 3]);
  });

  it("gives a Wednesday race's week before up to 2 easy runs 7 and 9 days out beside the race-week days", () => {
    const wednesday = "2026-10-14";
    const days = (daysPerWeek: number) =>
      raceWeekDays({
        raceDate: wednesday,
        startDate: "2026-08-03",
        daysPerWeek,
        lastHardDate: out(wednesday, 10),
        laidOutDates: [],
      });
    expect(days(4)).toEqual([
      day(wednesday, 4, "practice"),
      day(wednesday, 2, "primer"),
      day(wednesday, 5, "easy"),
      day(wednesday, 7, "extra"),
      day(wednesday, 9, "extra"),
    ]);
    expect(days(6).map((d) => d.daysOut)).toEqual([4, 2, 5, 3, 6, 7, 9]);
    expect(days(3).map((d) => d.daysOut)).toEqual([4, 2, 7, 9]);
  });

  it("gives a Monday race's week before one easy run 7 days out: 8 and 9 days out are in the week before it", () => {
    const monday = "2026-10-12";
    expect(
      raceWeekDays({
        raceDate: monday,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(monday, 8),
        laidOutDates: [],
      }).map((d) => [d.daysOut, d.kind]),
    ).toEqual([
      [4, "practice"],
      [2, "primer"],
      [5, "easy"],
      [7, "extra"],
    ]);
  });

  it("keeps every calendar week to the days asked for, the day before the race rest, and race practice 4 or 3 days out after 48 h", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 3, max: 6 }),
        fc.integer({ min: 0, max: 3 }),
        fc.option(fc.integer({ min: 3, max: 12 })),
        fc.subarray([6, 7, 8, 9, 10, 11, 12]),
        (raceWeekday, daysPerWeek, startWeeksBack, hardDaysOut, laidOutDaysOut) => {
          const raceDate = addDays("2026-10-05", raceWeekday);
          const startDate = addDays("2026-10-05", -7 * startWeeksBack);
          const lastHardDate = hardDaysOut === null ? null : out(raceDate, hardDaysOut);
          // Days laid out by a week before the race band, at most the days asked for in any week.
          const laidOutDates = laidOutDaysOut
            .map((d) => out(raceDate, d))
            .filter((date) => daysBetween(startDate, date) >= 0)
            .filter((date) => !isRaceBandWeek({ raceDate, weekStart: mondayOf(date) }))
            .slice(0, daysPerWeek - 1);
          const days = raceWeekDays({
            raceDate,
            startDate,
            daysPerWeek,
            lastHardDate,
            laidOutDates,
          });
          const dates = days.map((d) => d.date);
          expect(new Set(dates).size).toBe(dates.length);
          for (const d of days) {
            expect(daysBetween(startDate, d.date)).toBeGreaterThanOrEqual(0);
            expect(d.daysOut).toBe(daysBetween(d.date, raceDate));
            expect(laidOutDates).not.toContain(d.date);
            if (d.kind === "extra") {
              expect([7, 8, 9]).toContain(d.daysOut);
              expect(isRaceBandWeek({ raceDate, weekStart: mondayOf(d.date) })).toBe(true);
            } else {
              expect(d.daysOut).toBeGreaterThanOrEqual(2);
              expect(d.daysOut).toBeLessThanOrEqual(6);
            }
          }
          expect(days.filter((d) => d.kind !== "extra").length).toBeLessThanOrEqual(
            daysPerWeek - 1,
          );
          expect(days.filter((d) => d.kind === "extra").length).toBeLessThanOrEqual(2);
          const weeks = new Map<string, number>();
          for (const date of [...laidOutDates, raceDate, ...dates]) {
            weeks.set(mondayOf(date), (weeks.get(mondayOf(date)) ?? 0) + 1);
          }
          for (const runs of weeks.values()) expect(runs).toBeLessThanOrEqual(daysPerWeek);
          const practice = days.filter((d) => d.kind === "practice");
          expect(practice.length).toBeLessThanOrEqual(1);
          for (const p of practice) {
            expect([4, 3]).toContain(p.daysOut);
            if (lastHardDate !== null) {
              expect(daysBetween(lastHardDate, p.date)).toBeGreaterThanOrEqual(2);
            }
          }
          expect(days.filter((d) => d.kind === "primer").every((d) => d.daysOut === 2)).toBe(true);
        },
      ),
    );
  });
});

describe("race week sessions", () => {
  const sunday = (daysPerWeek: number) =>
    raceWeekDays({
      raceDate: SUNDAY,
      startDate: "2026-08-03",
      daysPerWeek,
      lastHardDate: out(SUNDAY, 7),
      laidOutDates: [],
    });
  const sized = (
    days: readonly RaceWeekDay[],
    overrides: Partial<Parameters<typeof raceWeekSessions>[0]> = {},
  ) =>
    raceWeekSessions({
      days,
      distanceKey: "half",
      paces: PACES,
      maxRunM: OPEN,
      windowCapM: OPEN,
      weekCapsM: {},
      ...overrides,
    });

  it("runs a half's race week on 4 days as 35 min easy, 3 x 1 km at race pace and 20 min with 4 strides", () => {
    const sessions = sized(sunday(4));
    expect(brief(sessions)).toEqual([
      ["2026-10-06", "easy", 6500],
      ["2026-10-07", "race_practice", practiceM(3, 1000)],
      ["2026-10-09", "easy", 3750 + 1116],
    ]);
    expect(sessions[0]!.steps).toEqual(plain(6500));
    expect(sessions[1]!.steps).toEqual([
      { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
      {
        repeat: 3,
        steps: [
          { kind: "work", zone: "race", distanceM: 1000, durationS: null },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 120 },
        ],
      },
      { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
    ]);
    expect(sessions[2]!.steps).toEqual([
      { kind: "run", zone: "easy", distanceM: 3750, durationS: null },
      {
        repeat: 4,
        steps: [
          { kind: "run", zone: "repetition", distanceM: null, durationS: 20 },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 60 },
        ],
      },
    ]);
    expect(sessions[2]!.target.zone).toBe("easy");
  });

  it("runs the race practice by distance: 5K 4 x 400 m, 10K 3 x 1 km, marathon 2 x 2 km", () => {
    const practice = (distanceKey: "5k" | "10k" | "marathon") =>
      sized(sunday(6), { distanceKey }).find((s) => s.type === "race_practice")!.target.distanceM;
    expect(practice("5k")).toBe(practiceM(4, 400));
    expect(practice("10k")).toBe(practiceM(3, 1000));
    expect(practice("marathon")).toBe(practiceM(2, 2000));
  });

  it("drops the primer's strides, then a practice rep, while the race week is over 20% hard: a marathon on 3 days", () => {
    // 2 x 2 km at 240 s/km is 960 s of 4220; without strides 960 of 3900; 1 x 2 km is 480 of 3180.
    const sessions = sized(sunday(3), { distanceKey: "marathon" });
    expect(brief(sessions)).toEqual([
      ["2026-10-07", "race_practice", 2813 + 2000 + 1875],
      ["2026-10-09", "easy", 3750],
    ]);
    expect(sessions[1]!.steps).toEqual(plain(3750));
  });

  it("rests the practice day when not even one rep keeps the race week 80% easy", () => {
    expect(sized([day(SUNDAY, 4, "practice")], { distanceKey: "marathon" })).toEqual([]);
  });

  it("keeps race-pace work within 10% of the race week's km with the race included: a 10K practice alone keeps 1 x 1 km", () => {
    // 3 x 1 km in 8813 m is over 10% of 18 813 m, 2 x 1 km over 10% of 17 438 m; 1 km is 10% of 15 688.
    expect(brief(sized([day(SUNDAY, 4, "practice")], { distanceKey: "10k" }))).toEqual([
      ["2026-10-07", "race_practice", 2813 + 1000 + 1875],
    ]);
  });

  it("shortens easy days toward 20 min in reverse pick order when the race week passes its cap, in whole 500 m", () => {
    // 6 days hold 31 179 m: 6 days out loses 1750 m to 20 min, 3 days out 1500 m to 4000 m.
    const sessions = sized(sunday(6), { windowCapM: 28_000 });
    expect(sumM(sized(sunday(6)))).toBe(31_179);
    expect(brief(sessions)).toEqual([
      ["2026-10-05", "easy", 3750],
      ["2026-10-06", "easy", 6500],
      ["2026-10-07", "race_practice", practiceM(3, 1000)],
      ["2026-10-08", "easy", 4000],
      ["2026-10-09", "easy", 4866],
    ]);
  });

  it("drops days in reverse pick order once every easy day is at 20 min", () => {
    expect(brief(sized(sunday(6), { windowCapM: 20_000 }))).toEqual([
      ["2026-10-06", "easy", 3750],
      ["2026-10-07", "race_practice", practiceM(3, 1000)],
      ["2026-10-09", "easy", 4866],
    ]);
  });

  it("holds each calendar week to its cap, trimming the extra easy runs of a Wednesday race's week before first", () => {
    const wednesday = "2026-10-14";
    const days = [
      day(wednesday, 4, "practice"),
      day(wednesday, 2, "primer"),
      day(wednesday, 5, "easy"),
      day(wednesday, 7, "extra"),
      day(wednesday, 9, "extra"),
    ];
    expect(brief(sized(days))).toEqual([
      ["2026-10-05", "easy", 5500],
      ["2026-10-07", "easy", 5500],
      ["2026-10-09", "easy", 6500],
      ["2026-10-10", "race_practice", practiceM(3, 1000)],
      ["2026-10-12", "easy", 4866],
    ]);
    // The week before holds 26 313 m; at 20 000 m the extras and 5 days out go to 20 min, then 9 days out.
    expect(brief(sized(days, { weekCapsM: { "2026-10-05": 20_000 } }))).toEqual([
      ["2026-10-07", "easy", 3750],
      ["2026-10-09", "easy", 3750],
      ["2026-10-10", "race_practice", practiceM(3, 1000)],
      ["2026-10-12", "easy", 4866],
    ]);
  });

  it("keeps every run within 110% of the recent longest: a 6 km cap shortens the easy days and the practice", () => {
    expect(brief(sized(sunday(4), { maxRunM: 6000 }))).toEqual([
      ["2026-10-06", "easy", 6000],
      ["2026-10-07", "race_practice", practiceM(1, 1000)],
      ["2026-10-09", "easy", 4866],
    ]);
    // Under 20 min plus strides the primer runs plain; under 20 min the days run what the cap allows.
    expect(brief(sized(sunday(4), { maxRunM: 4000 }))).toEqual([
      ["2026-10-06", "easy", 4000],
      ["2026-10-09", "easy", 3750],
    ]);
    expect(brief(sized(sunday(4), { maxRunM: 3000 }))).toEqual([
      ["2026-10-06", "easy", 3000],
      ["2026-10-09", "easy", 3000],
    ]);
  });

  it("keeps the caps, 80% easy, race-pace work within 10% with the race and every run whole, for any runner", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 3, max: 6 }),
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.double({ min: 30, max: 70, noNaN: true }),
        fc.integer({ min: 2000, max: 40_000 }),
        fc.integer({ min: 0, max: 40_000 }),
        fc.integer({ min: 0, max: 40_000 }),
        (raceWeekday, daysPerWeek, distanceKey, vdot, maxRunM, windowCapM, weekCapM) => {
          const raceDate = addDays("2026-10-05", raceWeekday);
          const days = raceWeekDays({
            raceDate,
            startDate: "2026-08-03",
            daysPerWeek,
            lastHardDate: out(raceDate, 7),
            laidOutDates: [],
          });
          const paces = { ...pacesFromVdot(vdot), race: pacesFromVdot(vdot).threshold };
          const firstWeek = mondayOf(out(raceDate, 9));
          const input = {
            days,
            distanceKey,
            paces,
            maxRunM,
            windowCapM,
            weekCapsM: { [firstWeek]: weekCapM },
          };
          const sessions = raceWeekSessions(input);
          expect(JSON.stringify(raceWeekSessions(input))).toBe(JSON.stringify(sessions));
          sessions.forEach((s) => expect(generatedSessionSchema.parse(s)).toEqual(s));
          expect(sessions.map((s) => s.date)).toEqual(
            days
              .map((d) => d.date)
              .filter((date) => sessions.some((s) => s.date === date))
              .sort(),
          );
          const window = sessions.filter((s) => daysBetween(s.date, raceDate) <= 6);
          expect(sumM(window)).toBeLessThanOrEqual(windowCapM);
          expect(sumM(sessions.filter((s) => mondayOf(s.date) === firstWeek))).toBeLessThanOrEqual(
            weekCapM,
          );
          for (const s of sessions) expect(s.target.distanceM).toBeLessThanOrEqual(maxRunM);
          expect(
            hardShareHolds({
              hardS: window.reduce((sum, s) => sum + hardTimeS(s.steps, paces), 0),
              totalS: window.reduce((sum, s) => sum + s.target.durationS, 0),
            }),
          ).toBe(true);
          const raceM = { "5k": 5000, "10k": 10_000, half: 21_098, marathon: 42_195 }[distanceKey];
          for (const practice of sessions.filter((s) => s.type === "race_practice")) {
            const work = practice.steps.flatMap((item) =>
              "repeat" in item
                ? item.steps.filter((s) => s.kind === "work").map((s) => item.repeat * s.distanceM!)
                : item.kind === "work"
                  ? [item.distanceM!]
                  : [],
            );
            expect(work.reduce((sum, m) => sum + m, 0)).toBeLessThanOrEqual(
              workCapM("race", sumM(window) + raceM),
            );
          }
        },
      ),
    );
  });
});
