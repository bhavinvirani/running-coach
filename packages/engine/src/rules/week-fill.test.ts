import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fillWeek, minRunDistanceM, tooManyDaysConflict } from "./week-fill";

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("week fill", () => {
  it("makes the shortest easy run 20 min at the easy midpoint, rounded up", () => {
    expect(minRunDistanceM(300)).toBe(4000);
    expect(minRunDistanceM(320)).toBe(3750);
    expect(minRunDistanceM(333)).toBe(3604);
  });

  it("reports too_many_days 1 m under the days' minimum runs, not at it", () => {
    expect(tooManyDaysConflict({ daysPerWeek: 6, startVolumeM: 23_999, minRunM: 4000 })).toEqual({
      code: "too_many_days",
      daysPerWeek: 6,
      maxDaysPerWeek: 5,
      baselineWeeklyM: 23_999,
    });
    expect(tooManyDaysConflict({ daysPerWeek: 6, startVolumeM: 24_000, minRunM: 4000 })).toBeNull();
    expect(tooManyDaysConflict({ daysPerWeek: 6, startVolumeM: 24_001, minRunM: 4000 })).toBeNull();
  });

  it("splits the rest of the week equally over the easy days, the odd meters to the first", () => {
    expect(
      fillWeek({ restM: 30_000, capM: 10_000, qualityM: [8000], easySlots: 3, minRunM: 3000 }),
    ).toEqual({
      easyRunsM: [7334, 7333, 7333],
      qualityPadM: [0],
    });
  });

  it("pads the quality warmups up to the long run before an easy run would pass it", () => {
    expect(
      fillWeek({ restM: 30_000, capM: 10_000, qualityM: [8000], easySlots: 2, minRunM: 3000 }),
    ).toEqual({
      easyRunsM: [10_000, 10_000],
      qualityPadM: [2000],
    });
  });

  it("pads quality sessions in order, each only up to the long run", () => {
    expect(
      fillWeek({
        restM: 40_000,
        capM: 10_000,
        qualityM: [8000, 9000],
        easySlots: 1,
        minRunM: 3000,
      }),
    ).toEqual({ easyRunsM: [10_000], qualityPadM: [2000, 1000] });
  });

  it("runs at what it can hold when every easy run and warmup is at the long run", () => {
    expect(
      fillWeek({ restM: 50_000, capM: 10_000, qualityM: [8000], easySlots: 2, minRunM: 3000 }),
    ).toEqual({
      easyRunsM: [10_000, 10_000],
      qualityPadM: [2000],
    });
  });

  it("uses fewer easy days when the rest only allows that many 20 min runs", () => {
    expect(
      fillWeek({ restM: 20_000, capM: 10_000, qualityM: [8000], easySlots: 3, minRunM: 5000 }),
    ).toEqual({
      easyRunsM: [6000, 6000],
      qualityPadM: [0],
    });
  });

  it("adds a run between half the long run and 20 min when the runs at 20 min would pass the long run", () => {
    expect(
      fillWeek({ restM: 19_000, capM: 5000, qualityM: [8000], easySlots: 3, minRunM: 4000 }),
    ).toEqual({
      easyRunsM: [3667, 3667, 3666],
      qualityPadM: [0],
    });
  });

  it("gives a rest under one 20 min run to the warmups instead of a shorter run", () => {
    expect(
      fillWeek({ restM: 6000, capM: 6000, qualityM: [4000], easySlots: 2, minRunM: 3000 }),
    ).toEqual({
      easyRunsM: [],
      qualityPadM: [2000],
    });
    expect(
      fillWeek({ restM: 10_000, capM: 6000, qualityM: [8000], easySlots: 2, minRunM: 3000 }),
    ).toEqual({
      easyRunsM: [],
      qualityPadM: [0],
    });
  });

  it("adds nothing when the quality sessions already take the rest", () => {
    expect(
      fillWeek({ restM: 5000, capM: 6000, qualityM: [8000], easySlots: 2, minRunM: 3000 }),
    ).toEqual({
      easyRunsM: [],
      qualityPadM: [0],
    });
  });

  it("pads the warmups with everything when there is no easy day", () => {
    expect(
      fillWeek({ restM: 20_000, capM: 6000, qualityM: [4000], easySlots: 0, minRunM: 3000 }),
    ).toEqual({
      easyRunsM: [],
      qualityPadM: [2000],
    });
  });

  it("never passes the rest, the cap or the easy days, and holds the rest whenever it fits", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 150_000 }),
        fc.integer({ min: 2000, max: 30_000 }),
        fc.array(fc.integer({ min: 3000, max: 20_000 }), { maxLength: 2 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1500, max: 5000 }),
        (restM, capM, qualityM, easySlots, minRunM) => {
          const { easyRunsM, qualityPadM } = fillWeek({
            restM,
            capM,
            qualityM,
            easySlots,
            minRunM,
          });
          const used = sum(qualityM) + sum(qualityPadM) + sum(easyRunsM);
          expect(used).toBeLessThanOrEqual(Math.max(restM, sum(qualityM)));
          expect(easyRunsM.length).toBeLessThanOrEqual(easySlots);
          easyRunsM.forEach((m) => {
            expect(Number.isInteger(m)).toBe(true);
            expect(m).toBeLessThanOrEqual(capM);
            expect(m).toBeGreaterThanOrEqual(Math.min(minRunM, Math.floor(capM / 2)));
          });
          qualityPadM.forEach((pad, k) => {
            expect(pad).toBeGreaterThanOrEqual(0);
            expect(pad).toBeLessThanOrEqual(Math.max(0, capM - qualityM[k]!));
          });
          const room = easySlots * capM + sum(qualityM.map((q) => Math.max(0, capM - q)));
          const rest = restM - sum(qualityM);
          if (rest >= minRunM && rest <= room && easySlots > 0) expect(used).toBe(restM);
        },
      ),
      { numRuns: 500 },
    );
  });
});
