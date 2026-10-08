import {
  generatedSessionSchema,
  raceDistanceKeySchema,
  type GeneratedSession,
  type PlanPaces,
  type Step,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, mondayOf } from "../dates";
import { hardShareHolds, hardTimeS } from "./easy-share";
import { workCapM } from "./quality";
import { raceWeekDays, raceWeekSessions, type RaceWeekDay } from "./race-week";
import { isRaceBandWeek } from "./taper-share";
import { bandMidpointSPerKm } from "./session-target";
import { pacesFromVdot } from "./vdot";
import { minRunDistanceM } from "./week-fill";

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
const hasStridesOn = (session: GeneratedSession) => session.steps.some((item) => "repeat" in item);
const brief = (sessions: readonly GeneratedSession[]) =>
  sessions.map((session) => [session.date, session.type, session.target.distanceM]);
const daysOutOf = (raceDate: string, sessions: readonly GeneratedSession[]) =>
  sessions.map((session) => daysBetween(session.date, raceDate));

/** Days a week before the race band lays out, from the plan's start, fewer than the days asked for. */
function laidOutOf(
  raceDate: string,
  startDate: string,
  daysPerWeek: number,
  daysOut: readonly number[],
): string[] {
  return daysOut
    .map((d) => out(raceDate, d))
    .filter((date) => daysBetween(startDate, date) >= 0)
    .filter((date) => !isRaceBandWeek({ raceDate, weekStart: mondayOf(date) }))
    .slice(0, daysPerWeek - 1);
}

/** Race practice of `reps` x `repM` at race pace, a 2 min jog after each of 2 or more, 15 min warm-up, 10 min cool-down. */
function practiceM(reps: number, repM: number): number {
  return 2813 + reps * repM + (reps === 1 ? 0 : reps * 375) + 1875;
}

describe("race week days", () => {
  it("offers race practice 4 days out, the primer 2 days out, then easy days 5, 3 and 6 days out, never the day before the race", () => {
    expect(
      raceWeekDays({
        raceDate: SUNDAY,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(SUNDAY, 7),
        laidOutDates: [],
      }),
    ).toEqual([
      day(SUNDAY, 4, "practice"),
      day(SUNDAY, 2, "primer"),
      day(SUNDAY, 5, "easy"),
      day(SUNDAY, 3, "easy"),
      day(SUNDAY, 6, "easy"),
    ]);
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
    ).toEqual([
      day(SUNDAY, 3, "practice"),
      day(SUNDAY, 2, "primer"),
      day(SUNDAY, 5, "easy"),
      day(SUNDAY, 6, "easy"),
    ]);
  });

  it("holds no race practice when 3 days out is under 48 h after the last hard day too", () => {
    expect(
      raceWeekDays({
        raceDate: SUNDAY,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(SUNDAY, 4),
        laidOutDates: [],
      }).map((d) => [d.daysOut, d.kind]),
    ).toEqual([
      [2, "primer"],
      [5, "easy"],
      [3, "easy"],
      [6, "easy"],
    ]);
  });

  it("moves race practice to 3 days out when the plan starts after 4 days out, and offers nothing before the start", () => {
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

  it("offers nothing before a race on the plan's first Tuesday: the Monday is the day before", () => {
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
      }).map((d) => [d.daysOut, d.kind]),
    ).toEqual([
      [3, "practice"],
      [2, "primer"],
      [5, "easy"],
      [6, "easy"],
    ]);
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

  it("offers a Wednesday race's week before its days 7, 9 and 8 out as extra easy days", () => {
    const wednesday = "2026-10-14";
    expect(
      raceWeekDays({
        raceDate: wednesday,
        startDate: "2026-08-03",
        daysPerWeek: 4,
        lastHardDate: out(wednesday, 10),
        laidOutDates: [],
      }).map((d) => [d.daysOut, d.kind]),
    ).toEqual([
      [4, "practice"],
      [2, "primer"],
      [5, "easy"],
      [3, "easy"],
      [6, "easy"],
      [7, "extra"],
      [9, "extra"],
      [8, "extra"],
    ]);
  });

  it("offers a Monday race's week before only 7 days out: 8 and 9 days out are in the week before it", () => {
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
      [3, "easy"],
      [6, "easy"],
      [7, "extra"],
    ]);
  });

  it("offers distinct days from the plan's start, none laid out or the day before the race, and race practice 4 or 3 days out after 48 h in a week with a day to spare", () => {
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
          const laidOutDates = laidOutOf(raceDate, startDate, daysPerWeek, laidOutDaysOut);
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
          const practice = days.filter((d) => d.kind === "practice");
          expect(practice.length).toBeLessThanOrEqual(1);
          for (const p of practice) {
            expect([4, 3]).toContain(p.daysOut);
            if (lastHardDate !== null) {
              expect(daysBetween(lastHardDate, p.date)).toBeGreaterThanOrEqual(2);
            }
            const taken = [...laidOutDates, raceDate].filter(
              (date) => mondayOf(date) === mondayOf(p.date),
            );
            expect(taken.length).toBeLessThan(daysPerWeek);
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
  // Every day offered may run, the race counted in its week, unless a test says otherwise.
  const sized = (
    days: readonly RaceWeekDay[],
    overrides: Partial<Parameters<typeof raceWeekSessions>[0]> = {},
  ) =>
    raceWeekSessions({
      days,
      daysPerWeek: 7,
      takenDates: days.length === 0 ? [] : [addDays(days[0]!.date, days[0]!.daysOut)],
      distanceKey: "half",
      paces: PACES,
      maxRunM: OPEN,
      windowCapM: OPEN,
      weekCapsM: {},
      ...overrides,
    });
  /** A Sunday race's week on the days asked for. */
  const onDays = (
    daysPerWeek: number,
    overrides: Partial<Parameters<typeof raceWeekSessions>[0]> = {},
  ) => sized(sunday(daysPerWeek), { daysPerWeek, ...overrides });

  it("runs the days asked for less the race: 3 days hold race practice and the primer, 4 add 35 min 5 days out, 6 run 4, 2, 5, 3 and 6 days out", () => {
    expect(daysOutOf(SUNDAY, onDays(3))).toEqual([4, 2]);
    expect(daysOutOf(SUNDAY, onDays(4))).toEqual([5, 4, 2]);
    expect(daysOutOf(SUNDAY, onDays(6))).toEqual([6, 5, 4, 3, 2]);
  });

  it("keeps each calendar week to the days asked for: a Thursday race whose week before runs 3 days of its own", () => {
    const thursday = "2026-10-15";
    // Tuesday to Thursday of the week before: 9, 8 and 7 days out.
    const laidOutDates = [out(thursday, 9), out(thursday, 8), out(thursday, 7)];
    const days = raceWeekDays({
      raceDate: thursday,
      startDate: "2026-08-03",
      daysPerWeek: 4,
      lastHardDate: out(thursday, 7),
      laidOutDates,
    });
    expect(
      sized(days, { daysPerWeek: 4, takenDates: [...laidOutDates, thursday] }).map((s) => [
        daysBetween(s.date, thursday),
        s.type,
      ]),
    ).toEqual([
      [4, "race_practice"],
      [3, "easy"],
      [2, "easy"],
    ]);
  });

  it("runs race practice 3 days out and the primer when the week before already runs every day asked for", () => {
    const thursday = "2026-10-15";
    const laidOutDates = [10, 9, 8, 7].map((d) => out(thursday, d));
    const days = raceWeekDays({
      raceDate: thursday,
      startDate: "2026-08-03",
      daysPerWeek: 4,
      lastHardDate: out(thursday, 7),
      laidOutDates,
    });
    expect(
      sized(days, { daysPerWeek: 4, takenDates: [...laidOutDates, thursday] }).map((s) => [
        daysBetween(s.date, thursday),
        s.type,
      ]),
    ).toEqual([
      [3, "race_practice"],
      [2, "easy"],
    ]);
  });

  it("gives a Wednesday race's week before up to 2 easy runs 7 and 9 days out beside the race week's days", () => {
    const wednesday = "2026-10-14";
    const days = raceWeekDays({
      raceDate: wednesday,
      startDate: "2026-08-03",
      daysPerWeek: 4,
      lastHardDate: out(wednesday, 10),
      laidOutDates: [],
    });
    const on = (daysPerWeek: number) => daysOutOf(wednesday, sized(days, { daysPerWeek }));
    expect(on(4)).toEqual([9, 7, 5, 4, 2]);
    expect(on(6)).toEqual([9, 7, 6, 5, 4, 3, 2]);
    expect(on(3)).toEqual([9, 7, 4, 2]);
  });

  it("gives a Monday race's week before one easy run 7 days out on 4 days: 8 and 9 days out are in the week before it", () => {
    const monday = "2026-10-12";
    const days = raceWeekDays({
      raceDate: monday,
      startDate: "2026-08-03",
      daysPerWeek: 4,
      lastHardDate: out(monday, 8),
      laidOutDates: [],
    });
    expect(daysOutOf(monday, sized(days, { daysPerWeek: 4 }))).toEqual([7, 5, 4, 2]);
  });

  it("runs 3 days out in race practice's place when no rep of it keeps the 6 days 80% easy: a race pace slower than easy", () => {
    // 1 x 1 km at 1650 s/km is over 20% hard beside the primer and 35 min 5 days out, so the
    // practice rests and 3 days out takes its place among the 3 days.
    const crawl: PlanPaces = { ...PACES, race: { fastSPerKm: 1600, slowSPerKm: 1700 } };
    expect(daysOutOf(SUNDAY, onDays(4, { paces: crawl }))).toEqual([5, 3, 2]);
  });

  it("runs a half's race week on 4 days as 35 min easy, 3 x 1 km at race pace and 20 min with 4 strides", () => {
    const sessions = onDays(4);
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
      onDays(6, { distanceKey }).find((s) => s.type === "race_practice")!.target.distanceM;
    expect(practice("5k")).toBe(practiceM(4, 400));
    expect(practice("10k")).toBe(practiceM(3, 1000));
    expect(practice("marathon")).toBe(practiceM(2, 2000));
  });

  it("drops the primer's strides, then a practice rep, while the race week is over 20% hard: a marathon on 3 days", () => {
    // 2 x 2 km at 240 s/km is 960 s of 4220; without strides 960 of 3900; 1 x 2 km is 480 of 3180.
    const sessions = onDays(3, { distanceKey: "marathon" });
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
    const sessions = onDays(6, { windowCapM: 28_000 });
    expect(sumM(onDays(6))).toBe(31_179);
    expect(brief(sessions)).toEqual([
      ["2026-10-05", "easy", 3750],
      ["2026-10-06", "easy", 6500],
      ["2026-10-07", "race_practice", practiceM(3, 1000)],
      ["2026-10-08", "easy", 4000],
      ["2026-10-09", "easy", 4866],
    ]);
  });

  it("gives a day up when even every easy day at 20 min passes the cap, and leaves the others their length", () => {
    // Race practice and the primer take 13 679 m of 20 000: 5 days out shortens to 6000 m; 3 and 6
    // days out would need it and themselves at 20 min (21 179 m), so they rest.
    expect(brief(onDays(6, { windowCapM: 20_000 }))).toEqual([
      ["2026-10-06", "easy", 6000],
      ["2026-10-07", "race_practice", practiceM(3, 1000)],
      ["2026-10-09", "easy", 4866],
    ]);
  });

  it("never leaves the race week empty: a practice no rep keeps 80% easy beside the days that fit rests, and the days are sized again without it", () => {
    // A Monday 10K on 3 days at a slow race pace (380 s/km): 1 x 1 km is 380 s hard of 1880. Under
    // a 9000 m cap nothing fits beside the practice, which alone is over 20% hard, so it rests; the
    // primer and 35 min 5 days out, shortened to 4000 m, take its place.
    const monday = "2026-10-12";
    const slow: PlanPaces = { ...PACES, race: { fastSPerKm: 375, slowSPerKm: 385 } };
    const days = raceWeekDays({
      raceDate: monday,
      startDate: "2026-08-03",
      daysPerWeek: 3,
      lastHardDate: out(monday, 8),
      laidOutDates: [],
    });
    const sessions = sized(days, {
      daysPerWeek: 3,
      distanceKey: "10k",
      paces: slow,
      windowCapM: 9000,
      weekCapsM: { "2026-10-05": 9000 },
    });
    expect(brief(sessions)).toEqual([
      ["2026-10-07", "easy", 4000],
      ["2026-10-10", "easy", 4866],
    ]);
    expect(hasStridesOn(sessions[1]!)).toBe(true);
  });

  it("keeps the extra easy runs of a Wednesday race's week before that fit, once 5 and 3 days out cannot", () => {
    // Race practice and the primer fill the 6 days' 15 000 m; the week before holds the practice
    // and up to 17 000 m, so 9 and 7 days out run at 20 min and 4000 m.
    const wednesday = "2026-10-14";
    const days = raceWeekDays({
      raceDate: wednesday,
      startDate: "2026-08-03",
      daysPerWeek: 5,
      lastHardDate: out(wednesday, 10),
      laidOutDates: [],
    });
    expect(
      brief(
        sized(days, { daysPerWeek: 5, windowCapM: 15_000, weekCapsM: { "2026-10-05": 17_000 } }),
      ),
    ).toEqual([
      ["2026-10-05", "easy", 3750],
      ["2026-10-07", "easy", 4000],
      ["2026-10-10", "race_practice", practiceM(3, 1000)],
      ["2026-10-12", "easy", 4866],
    ]);
  });

  it("holds each calendar week to its cap, shortening the extra easy runs of a Wednesday race's week before first", () => {
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
    // The week before holds 26 313 m. At 20 000 m 7 days out shortens to 4500 m; 9 days out would
    // need every easy day at 20 min and still pass, so it rests and the others keep their length.
    expect(brief(sized(days, { weekCapsM: { "2026-10-05": 20_000 } }))).toEqual([
      ["2026-10-07", "easy", 4500],
      ["2026-10-09", "easy", 6500],
      ["2026-10-10", "race_practice", practiceM(3, 1000)],
      ["2026-10-12", "easy", 4866],
    ]);
  });

  it("keeps every run within 110% of the recent longest: a 6 km cap shortens the easy days and the practice, a 4 km one rests it", () => {
    expect(brief(onDays(4, { maxRunM: 6000 }))).toEqual([
      ["2026-10-06", "easy", 6000],
      ["2026-10-07", "race_practice", practiceM(1, 1000)],
      ["2026-10-09", "easy", 4866],
    ]);
    // No rep fits 4000 m, so 3 days out runs in the practice's place; under 20 min plus strides the
    // primer runs plain; under 20 min the days run what the cap allows.
    expect(brief(onDays(4, { maxRunM: 4000 }))).toEqual([
      ["2026-10-06", "easy", 4000],
      ["2026-10-08", "easy", 4000],
      ["2026-10-09", "easy", 3750],
    ]);
    expect(brief(onDays(4, { maxRunM: 3000 }))).toEqual([
      ["2026-10-06", "easy", 3000],
      ["2026-10-08", "easy", 3000],
      ["2026-10-09", "easy", 3000],
    ]);
  });

  it("keeps the days asked for, the caps, 80% easy, race-pace work within 10% with the race and every run whole, and rests a day only when it does not fit, for any runner", () => {
    fc.assert(
      fc.property(
        fc.record({
          raceWeekday: fc.integer({ min: 0, max: 6 }),
          daysPerWeek: fc.integer({ min: 3, max: 6 }),
          startWeeksBack: fc.integer({ min: 0, max: 3 }),
          hardDaysOut: fc.option(fc.integer({ min: 3, max: 12 })),
          laidOutDaysOut: fc.subarray([6, 7, 8, 9, 10, 11, 12]),
          distanceKey: fc.constantFrom(...raceDistanceKeySchema.options),
          vdot: fc.double({ min: 30, max: 70, noNaN: true }),
          maxRunM: fc.integer({ min: 2000, max: 40_000 }),
          windowCapM: fc.integer({ min: 0, max: 40_000 }),
          weekCapM: fc.integer({ min: 0, max: 40_000 }),
        }),
        (drawn) => {
          const { daysPerWeek, distanceKey, maxRunM, windowCapM, weekCapM } = drawn;
          const raceDate = addDays("2026-10-05", drawn.raceWeekday);
          const startDate = addDays("2026-10-05", -7 * drawn.startWeeksBack);
          const laidOutDates = laidOutOf(raceDate, startDate, daysPerWeek, drawn.laidOutDaysOut);
          const days = raceWeekDays({
            raceDate,
            startDate,
            daysPerWeek,
            lastHardDate: drawn.hardDaysOut === null ? null : out(raceDate, drawn.hardDaysOut),
            laidOutDates,
          });
          const paces = {
            ...pacesFromVdot(drawn.vdot),
            race: pacesFromVdot(drawn.vdot).threshold,
          };
          const firstWeek = mondayOf(out(raceDate, 9));
          const takenDates = [...laidOutDates, raceDate];
          const input = {
            days,
            daysPerWeek,
            takenDates,
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
          const extras = sessions.filter((s) => daysBetween(s.date, raceDate) > 6);
          const runsIn = (weekStart: string) =>
            [...takenDates, ...sessions.map((s) => s.date)].filter(
              (date) => mondayOf(date) === weekStart,
            ).length;
          // The days asked for: the race counts as one, and so do the days laid out in their weeks.
          expect(window.length).toBeLessThanOrEqual(daysPerWeek - 1);
          expect(extras.length).toBeLessThanOrEqual(2);
          for (const s of sessions)
            expect(runsIn(mondayOf(s.date))).toBeLessThanOrEqual(daysPerWeek);
          expect(sessions.filter((s) => s.type === "race_practice").length).toBeLessThanOrEqual(1);
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
          // Never empty while any one of its days would run alone.
          if (days.some((d) => raceWeekSessions({ ...input, days: [d] }).length > 0)) {
            expect(sessions.length).toBeGreaterThan(0);
          }
          // An easy day, an extra one included, rests only when the days asked for are full or it
          // would pass a cap at its shortest with every easy day kept at its shortest too.
          const minRunM = minRunDistanceM(bandMidpointSPerKm(paces.easy));
          const kindOf = new Map(days.map((d) => [d.date, d.kind]));
          const shortestM = (s: GeneratedSession) =>
            kindOf.get(s.date) === "easy" || kindOf.get(s.date) === "extra"
              ? Math.min(s.target.distanceM, minRunM)
              : s.target.distanceM;
          for (const d of days) {
            if (
              (d.kind !== "easy" && d.kind !== "extra") ||
              sessions.some((s) => s.date === d.date)
            ) {
              continue;
            }
            const full =
              (d.kind === "extra" ? extras.length === 2 : window.length === daysPerWeek - 1) ||
              runsIn(mondayOf(d.date)) === daysPerWeek;
            const ownM = Math.min(minRunM, maxRunM);
            const passesWeek =
              mondayOf(d.date) === firstWeek &&
              sessions
                .filter((s) => mondayOf(s.date) === firstWeek)
                .reduce((sum, s) => sum + shortestM(s), 0) +
                ownM >
                weekCapM;
            const passesWindow =
              d.kind === "easy" &&
              window.reduce((sum, s) => sum + shortestM(s), 0) + ownM > windowCapM;
            expect(full || passesWeek || passesWindow, `${d.daysOut} days out rests`).toBe(true);
          }
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
      { numRuns: 300 },
    );
  });
});
