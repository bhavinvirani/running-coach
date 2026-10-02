import { planPhaseSchema, raceDistanceKeySchema, type PlanPaces } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  dropRep,
  qualityCount,
  qualitySteps,
  qualityZones,
  QUALITY_SESSION_TYPE,
  qualityWork,
  workCapM,
  type WorkZone,
} from "./quality";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 },
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 },
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 223 },
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};
const ZONES: readonly WorkZone[] = ["threshold", "interval", "repetition", "race"];
const SHARE = { threshold: 0.1, interval: 0.08, repetition: 0.05, race: 0.1 };

describe("quality", () => {
  it("runs 1 quality session in base, taper and race weeks at any days a week", () => {
    for (const daysPerWeek of [3, 6]) {
      expect(qualityCount({ phase: "base", daysPerWeek })).toBe(1);
      expect(qualityCount({ phase: "taper", daysPerWeek })).toBe(1);
      expect(qualityCount({ phase: "race", daysPerWeek })).toBe(1);
    }
  });

  it("runs at most 2 in build and peak, and 1 at 3 days a week", () => {
    expect(qualityCount({ phase: "build", daysPerWeek: 3 })).toBe(1);
    expect(qualityCount({ phase: "build", daysPerWeek: 4 })).toBe(2);
    expect(qualityCount({ phase: "peak", daysPerWeek: 6 })).toBe(2);
  });

  it("with one session in base, cycles tempo, intervals, tempo, repetitions by week, then repeats", () => {
    const base = (weekNumber: number) =>
      qualityZones({ phase: "base", weekNumber, daysPerWeek: 4 });
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(base)).toEqual(
      [
        "threshold",
        "interval",
        "threshold",
        "repetition",
        "threshold",
        "interval",
        "threshold",
        "repetition",
      ].map((zone) => [zone]),
    );
  });

  it("with one session in build at 3 days a week, keeps the same 4-week cycle, so tempo comes every other week", () => {
    const build = (weekNumber: number) =>
      qualityZones({ phase: "build", weekNumber, daysPerWeek: 3 });
    expect(build(5)).toEqual(["threshold"]);
    expect(build(6)).toEqual(["interval"]);
    expect(build(7)).toEqual(["threshold"]);
    expect(build(8)).toEqual(["repetition"]);
  });

  it("with two sessions in build, alternates intervals and repetitions by week, tempo second", () => {
    expect(qualityZones({ phase: "build", weekNumber: 5, daysPerWeek: 4 })).toEqual([
      "interval",
      "threshold",
    ]);
    expect(qualityZones({ phase: "build", weekNumber: 6, daysPerWeek: 5 })).toEqual([
      "repetition",
      "threshold",
    ]);
  });

  it("with one session in peak, alternates race practice (odd weeks) and tempo (even weeks)", () => {
    expect(qualityZones({ phase: "peak", weekNumber: 9, daysPerWeek: 3 })).toEqual(["race"]);
    expect(qualityZones({ phase: "peak", weekNumber: 10, daysPerWeek: 3 })).toEqual(["threshold"]);
    expect(qualityZones({ phase: "peak", weekNumber: 11, daysPerWeek: 3 })).toEqual(["race"]);
  });

  it("with two sessions in peak, runs race practice first and tempo second every week", () => {
    expect(qualityZones({ phase: "peak", weekNumber: 9, daysPerWeek: 4 })).toEqual([
      "race",
      "threshold",
    ]);
    expect(qualityZones({ phase: "peak", weekNumber: 10, daysPerWeek: 6 })).toEqual([
      "race",
      "threshold",
    ]);
  });

  it("keeps the one session of taper and race weeks race practice, odd and even weeks", () => {
    for (const daysPerWeek of [3, 6]) {
      expect(qualityZones({ phase: "taper", weekNumber: 11, daysPerWeek })).toEqual(["race"]);
      expect(qualityZones({ phase: "taper", weekNumber: 12, daysPerWeek })).toEqual(["race"]);
      expect(qualityZones({ phase: "race", weekNumber: 12, daysPerWeek })).toEqual(["race"]);
      expect(qualityZones({ phase: "race", weekNumber: 13, daysPerWeek })).toEqual(["race"]);
    }
  });

  it("types threshold work tempo, interval and repetition work intervals, race pace race practice", () => {
    expect(QUALITY_SESSION_TYPE).toEqual({
      threshold: "tempo",
      interval: "intervals",
      repetition: "intervals",
      race: "race_practice",
    });
  });

  it("caps work per session at T 10%, I 8%, R 5% and race pace 10% of the week, in whole meters", () => {
    expect(workCapM("threshold", 40_000)).toBe(4000);
    expect(workCapM("interval", 40_000)).toBe(3200);
    expect(workCapM("repetition", 40_000)).toBe(2000);
    expect(workCapM("race", 40_005)).toBe(4000);
  });

  it("takes 1000 m intervals when 2 fit and 800 m below that, 3 min easy between", () => {
    expect(qualityWork({ zone: "interval", distanceKey: "10k", capM: 2000 })).toEqual({
      zone: "interval",
      repM: 1000,
      reps: 2,
      recoveryS: 180,
    });
    expect(qualityWork({ zone: "interval", distanceKey: "10k", capM: 1999 })).toEqual({
      zone: "interval",
      repM: 800,
      reps: 2,
      recoveryS: 180,
    });
    expect(qualityWork({ zone: "interval", distanceKey: "10k", capM: 800 })).toMatchObject({
      repM: 800,
      reps: 1,
    });
    expect(qualityWork({ zone: "interval", distanceKey: "10k", capM: 799 })).toBeNull();
  });

  it("takes 400 m repetitions when 2 fit and 200 m below that, 2 min easy between", () => {
    expect(qualityWork({ zone: "repetition", distanceKey: "5k", capM: 800 })).toEqual({
      zone: "repetition",
      repM: 400,
      reps: 2,
      recoveryS: 120,
    });
    expect(qualityWork({ zone: "repetition", distanceKey: "5k", capM: 799 })).toMatchObject({
      repM: 200,
      reps: 3,
    });
    expect(qualityWork({ zone: "repetition", distanceKey: "5k", capM: 199 })).toBeNull();
  });

  it("runs threshold as one block for 5K and 10K and two for the half and marathon, in whole 100 m", () => {
    expect(qualityWork({ zone: "threshold", distanceKey: "10k", capM: 4050 })).toEqual({
      zone: "threshold",
      repM: 4000,
      reps: 1,
      recoveryS: 60,
    });
    expect(qualityWork({ zone: "threshold", distanceKey: "half", capM: 4050 })).toEqual({
      zone: "threshold",
      repM: 2000,
      reps: 2,
      recoveryS: 60,
    });
    expect(qualityWork({ zone: "threshold", distanceKey: "half", capM: 199 })).toBeNull();
  });

  it("runs race practice in blocks by distance", () => {
    expect(qualityWork({ zone: "race", distanceKey: "5k", capM: 2000 })).toMatchObject({
      repM: 1000,
      reps: 2,
    });
    expect(qualityWork({ zone: "race", distanceKey: "5k", capM: 1999 })).toMatchObject({
      repM: 400,
      reps: 4,
    });
    expect(qualityWork({ zone: "race", distanceKey: "marathon", capM: 7200 })).toMatchObject({
      repM: 2000,
      reps: 3,
    });
    expect(qualityWork({ zone: "race", distanceKey: "marathon", capM: 10_000 })).toEqual({
      zone: "race",
      repM: 5000,
      reps: 2,
      recoveryS: 120,
    });
  });

  it("drops one rep, and the work entirely at the last one", () => {
    const work = { zone: "interval" as const, repM: 1000, reps: 2, recoveryS: 180 };
    expect(dropRep(work)).toEqual({ ...work, reps: 1 });
    expect(dropRep({ ...work, reps: 1 })).toBeNull();
  });

  it("wraps repeated work in a 15 min warmup and 10 min cooldown by time", () => {
    expect(
      qualitySteps({
        work: { zone: "interval", repM: 1000, reps: 3, recoveryS: 180 },
        warmupPadM: 0,
        paces: PACES,
      }),
    ).toEqual([
      { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
      {
        repeat: 3,
        steps: [
          { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
        ],
      },
      { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
    ]);
  });

  it("runs a single block without a repeat or recovery, and pads the warmup by distance", () => {
    expect(
      qualitySteps({
        work: { zone: "threshold", repM: 4000, reps: 1, recoveryS: 60 },
        warmupPadM: 500,
        paces: PACES,
      }),
    ).toEqual([
      // 900 s at the 320 s/km easy midpoint is 2813 m, plus 500 m.
      { kind: "warmup", zone: "easy", distanceM: 3313, durationS: null },
      { kind: "work", zone: "threshold", distanceM: 4000, durationS: null },
      { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
    ]);
  });

  it("keeps every session's work within its cap, in whole meters, for every zone and distance", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 150_000 }),
        (zone, distanceKey, weekVolumeM) => {
          const capM = workCapM(zone, weekVolumeM);
          expect(capM).toBeLessThanOrEqual(SHARE[zone] * weekVolumeM);
          const work = qualityWork({ zone, distanceKey, capM });
          if (work === null) return;
          expect(Number.isInteger(work.repM) && work.repM > 0 && work.reps >= 1).toBe(true);
          expect(work.repM * work.reps).toBeLessThanOrEqual(capM);
          expect(work.zone).toBe(zone);
        },
      ),
    );
  });

  it("with one session in base or build, runs tempo at least every other week", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("base" as const, "build" as const),
        fc.integer({ min: 1, max: 40 }),
        (phase, weekNumber) => {
          const zones = [weekNumber, weekNumber + 1].flatMap((week) =>
            qualityZones({ phase, weekNumber: week, daysPerWeek: 3 }),
          );
          expect(zones).toContain("threshold");
        },
      ),
    );
  });

  it("never asks for more than 2 sessions, nor more than 1 at 3 days a week", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...planPhaseSchema.options),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 3, max: 6 }),
        (phase, weekNumber, daysPerWeek) => {
          const zones = qualityZones({ phase, weekNumber, daysPerWeek });
          expect(zones.length).toBe(qualityCount({ phase, daysPerWeek }));
          expect(zones.length).toBeLessThanOrEqual(daysPerWeek === 3 ? 1 : 2);
        },
      ),
    );
  });
});
