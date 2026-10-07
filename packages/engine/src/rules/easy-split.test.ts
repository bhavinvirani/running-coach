import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { easyRunCapM, easySharesPercent, easySplitM } from "./easy-split";

const MON = 0;
const TUE = 1;
const WED = 2;
const THU = 3;
const FRI = 4;
const SAT = 5;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("easy split", () => {
  it("gives 1 run all of it, 2 runs 58 and 42%, 3 runs 42, 33 and 25%, 4 runs 34, 27, 22 and 17%", () => {
    const shares = (days: number[]) => easySharesPercent({ days, afterLongDay: -1, weekNumber: 1 });
    expect(shares([TUE])).toEqual([100]);
    expect(shares([TUE, THU])).toEqual([58, 42]);
    expect(shares([TUE, THU, SAT])).toEqual([42, 33, 25]);
    expect(shares([MON, TUE, THU, SAT])).toEqual([34, 27, 22, 17]);
  });

  it("extends to 5 runs, 6 days a week with the quality session run easy: 28, 23, 19, 16 and 14%", () => {
    expect(
      easySharesPercent({ days: [MON, TUE, WED, THU, FRI], afterLongDay: -1, weekNumber: 1 }),
    ).toEqual([28, 23, 19, 16, 14]);
  });

  it("rejects no runs or more than 5 as a programmer error", () => {
    expect(() => easySharesPercent({ days: [], afterLongDay: MON, weekNumber: 1 })).toThrow(
      RangeError,
    );
    expect(() =>
      easySharesPercent({
        days: [MON, TUE, WED, THU, FRI, SAT],
        afterLongDay: MON,
        weekNumber: 1,
      }),
    ).toThrow(RangeError);
  });

  it("gives the run the day after the long run the smallest share, the rest largest first in date order in odd weeks", () => {
    // A Sunday long run: Monday is the day after it.
    expect(
      easySharesPercent({ days: [WED, MON, SAT, FRI], afterLongDay: MON, weekNumber: 9 }),
    ).toEqual([34, 17, 22, 27]);
  });

  it("gives the larger shares in reverse date order in even weeks, the day after the long run still smallest", () => {
    expect(
      easySharesPercent({ days: [WED, MON, SAT, FRI], afterLongDay: MON, weekNumber: 10 }),
    ).toEqual([22, 17, 34, 27]);
    expect(easySharesPercent({ days: [TUE, THU], afterLongDay: -1, weekNumber: 2 })).toEqual([
      42, 58,
    ]);
  });

  it("caps an easy run at 85% of the long run, in whole meters", () => {
    expect(easyRunCapM({ longM: 20_000, minRunM: 3750 })).toBe(17_000);
    expect(easyRunCapM({ longM: 20_001, minRunM: 3750 })).toBe(17_000);
    expect(easyRunCapM({ longM: 20_002, minRunM: 3750 })).toBe(17_001);
  });

  it("keeps the 20 min floor where 85% of the long run is under it, but never past the long run", () => {
    // 85% of 4412 m is 3750.2 m: the share holds. 85% of 4411 m is 3749.35 m: 20 min wins.
    expect(easyRunCapM({ longM: 4412, minRunM: 3750 })).toBe(3750);
    expect(easyRunCapM({ longM: 4411, minRunM: 3750 })).toBe(3750);
    expect(easyRunCapM({ longM: 4000, minRunM: 3750 })).toBe(3750);
    expect(easyRunCapM({ longM: 3600, minRunM: 3750 })).toBe(3600);
  });

  it("splits by the shares when no run reaches a cap or the floor", () => {
    expect(
      easySplitM({
        totalM: 10_000,
        days: [MON, THU],
        afterLongDay: MON,
        weekNumber: 1,
        minM: 3000,
        maxM: 8000,
      }),
    ).toEqual([4200, 5800]);
  });

  it("moves the excess over the cap to the other runs by their shares: the cap at exactly 85% of the long run", () => {
    // 3 runs beside a 20 000 m long run, capped at 17 000 m. Of 45 000 m, 42% is 18 900 m: that run
    // takes the cap and the other two share the 28 000 m left 33 to 25.
    const split = (totalM: number) =>
      easySplitM({
        totalM,
        days: [TUE, THU, SAT],
        afterLongDay: MON,
        weekNumber: 1,
        minM: 3750,
        maxM: 17_000,
      });
    expect(split(24_000)).toEqual([10_080, 7920, 6000]);
    expect(split(45_000)).toEqual([17_000, 15_932, 12_068]);
    expect(split(51_000)).toEqual([17_000, 17_000, 17_000]);
  });

  it("raises a run under 20 min to it and takes the meters from the others by their shares", () => {
    // 25% of 12 000 m is 3000 m, under the 3750 m floor; 33% of the 8250 m left is under it too, so the
    // largest share takes the remaining 4500 m.
    expect(
      easySplitM({
        totalM: 12_000,
        days: [TUE, THU, SAT],
        afterLongDay: MON,
        weekNumber: 1,
        minM: 3750,
        maxM: 17_000,
      }),
    ).toEqual([4500, 3750, 3750]);
    expect(
      easySplitM({
        totalM: 15_000,
        days: [TUE, THU, SAT],
        afterLongDay: MON,
        weekNumber: 1,
        minM: 3750,
        maxM: 17_000,
      }),
    ).toEqual([6300, 4950, 3750]);
  });

  it("holds every run at 20 min when the total is exactly 20 min a run", () => {
    expect(
      easySplitM({
        totalM: 3 * 3750,
        days: [TUE, THU, SAT],
        afterLongDay: MON,
        weekNumber: 1,
        minM: 3750,
        maxM: 17_000,
      }),
    ).toEqual([3750, 3750, 3750]);
    expect(
      easySplitM({
        totalM: 3 * 3750 + 1,
        days: [TUE, THU, SAT],
        afterLongDay: MON,
        weekNumber: 1,
        minM: 3750,
        maxM: 17_000,
      }),
    ).toEqual([3751, 3750, 3750]);
  });

  it("gives the meters whole division leaves to the larger shares first", () => {
    // 58% and 42% of 10 001 m are 5800.58 and 4200.42 m.
    expect(
      easySplitM({
        totalM: 10_001,
        days: [TUE, THU],
        afterLongDay: MON,
        weekNumber: 1,
        minM: 3000,
        maxM: 8000,
      }),
    ).toEqual([5801, 4200]);
  });

  it("rejects a total the runs cannot hold between the floor and the cap as a programmer error", () => {
    const of = (totalM: number) => () =>
      easySplitM({
        totalM,
        days: [TUE, THU],
        afterLongDay: MON,
        weekNumber: 1,
        minM: 3000,
        maxM: 8000,
      });
    expect(of(5999)).toThrow(RangeError);
    expect(of(16_001)).toThrow(RangeError);
    expect(of(6000)()).toEqual([3000, 3000]);
    expect(of(16_000)()).toEqual([8000, 8000]);
  });

  it("holds the total exactly in whole meters between the floor and the cap, the day after the long run never longer than another", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1500, max: 5000 }),
        fc.integer({ min: 0, max: 25_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (days, afterLongDay, weekNumber, minM, spanM, at) => {
          const maxM = minM + spanM;
          const n = days.length;
          const totalM = n * minM + Math.floor(at * n * spanM);
          const runs = easySplitM({ totalM, days, afterLongDay, weekNumber, minM, maxM });
          expect(runs).toHaveLength(n);
          expect(sum(runs)).toBe(totalM);
          for (const run of runs) {
            expect(Number.isInteger(run)).toBe(true);
            expect(run).toBeGreaterThanOrEqual(minM);
            expect(run).toBeLessThanOrEqual(maxM);
          }
          const after = days.indexOf(afterLongDay);
          if (after !== -1) expect(Math.min(...runs)).toBe(runs[after]);
          // A larger share never runs shorter.
          const shares = easySharesPercent({ days, afterLongDay, weekNumber });
          for (let a = 0; a < n; a += 1) {
            for (let b = 0; b < n; b += 1) {
              if (shares[a]! > shares[b]!) expect(runs[a]).toBeGreaterThanOrEqual(runs[b]!);
            }
          }
          expect(easySplitM({ totalM, days, afterLongDay, weekNumber, minM, maxM })).toEqual(runs);
        },
      ),
      { numRuns: 500 },
    );
  });
});
