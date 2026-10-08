import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { easyRunCapM } from "./easy-split";
import { fillWeek, minRunDistanceM, type FillWeekInput } from "./week-fill";

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const MON = 0;
const WED = 2;
const FRI = 4;
// At the 320 s/km easy midpoint: 20 min is 3750 m, the 15 min warm-up 2813 m (the shortest easy run
// where 20 min ones would leave a gap too) and the 10 min cool-down 1875 m; 25 min is 4687 m, so a
// warm-up takes 1874 m more at most and a cool-down 2812 m.
const PACE = 320;
const WARMUP_PAD_MAX_M = 1874;
const COOLDOWN_PAD_MAX_M = 2812;

function fill(input: Partial<FillWeekInput>) {
  return fillWeek({
    restM: 0,
    longM: 16_000,
    qualityM: [8000],
    easyDays: [WED, FRI, MON],
    afterLongDay: MON,
    weekNumber: 1,
    minRunM: 3750,
    easyPaceSPerKm: PACE,
    keepDays: false,
    ...input,
  });
}

const noPad = { warmupM: 0, cooldownM: 0 };

describe("week fill", () => {
  it("makes the shortest easy run 20 min at the easy midpoint, rounded up", () => {
    expect(minRunDistanceM(300)).toBe(4000);
    expect(minRunDistanceM(320)).toBe(3750);
    expect(minRunDistanceM(333)).toBe(3604);
  });

  it("splits the easy runs unequally, the day after the long run shortest, in whole 500 m with the remainder on the longest", () => {
    // 22 000 m easy: Wednesday 42%, Friday 33%, Monday after the Sunday long run 25%: 9240, 7260 and
    // 5500 m, rounded down to 9000, 7000 and 5500 m with the 500 m they gave up on Wednesday.
    expect(fill({ restM: 30_000 })).toEqual({
      easyRunsM: [9500, 7000, 5500],
      qualityPadM: [noPad],
    });
  });

  it("gives the larger shares in reverse date order in even weeks", () => {
    expect(fill({ restM: 30_000, weekNumber: 2 })).toEqual({
      easyRunsM: [7000, 9500, 5500],
      qualityPadM: [noPad],
    });
  });

  it("runs every easy run at exactly 85% of the long run when the rest fills them, with nothing left over", () => {
    expect(fill({ restM: 25_000, longM: 10_000, easyDays: [WED, FRI] })).toEqual({
      easyRunsM: [8500, 8500],
      qualityPadM: [noPad],
    });
  });

  it("pads the quality sessions with what passes the easy runs' cap, 60% to the warm-up and 40% to the cool-down", () => {
    expect(fill({ restM: 27_000, longM: 10_000, easyDays: [WED, FRI] })).toEqual({
      easyRunsM: [8500, 8500],
      qualityPadM: [{ warmupM: 1200, cooldownM: 800 }],
    });
  });

  it("stops a warm-up and a cool-down at 25 min each and does not run the rest", () => {
    const week = fill({ restM: 35_000, longM: 20_000, easyDays: [WED] });
    expect(week).toEqual({
      easyRunsM: [17_000],
      qualityPadM: [{ warmupM: WARMUP_PAD_MAX_M, cooldownM: COOLDOWN_PAD_MAX_M }],
    });
    expect(35_000 - 8000 - 17_000 - WARMUP_PAD_MAX_M - COOLDOWN_PAD_MAX_M).toBe(5314);
  });

  it("never pads a quality session past the long run", () => {
    expect(fill({ restM: 21_000, longM: 10_000, qualityM: [9500], easyDays: [WED] })).toEqual({
      easyRunsM: [8500],
      qualityPadM: [{ warmupM: 300, cooldownM: 200 }],
    });
  });

  it("gives two quality sessions equal shares of what is left over, the odd meter to the first", () => {
    expect(fill({ restM: 28_201, longM: 12_000, qualityM: [8000, 7000], easyDays: [WED] })).toEqual(
      {
        easyRunsM: [10_200],
        qualityPadM: [
          { warmupM: 900, cooldownM: 601 },
          { warmupM: 900, cooldownM: 600 },
        ],
      },
    );
  });

  it("uses fewer easy days when the rest only allows that many 20 min runs, on the first days in fill order", () => {
    // 9000 m holds two 20 min runs: Wednesday 58% and Friday 42%; Friday's 3500 m step would be under
    // 20 min, so it keeps its 3780 m and Wednesday carries 220 m.
    expect(fill({ restM: 17_000 })).toEqual({
      easyRunsM: [5220, 3780],
      qualityPadM: [noPad],
    });
  });

  it("runs equal runs between half the cap and 20 min when 20 min runs would pass the cap", () => {
    // A 4000 m long run caps easy runs at 20 min (85% of it is under), so 9000 m is 3 runs of 3000 m.
    expect(fill({ restM: 17_000, longM: 4000 })).toEqual({
      easyRunsM: [3000, 3000, 3000],
      qualityPadM: [noPad],
    });
  });

  it("runs fewer easy days of at least 15 min instead of shorter ones where half the cap is under 15 min: one 3000 m run, not two of 2500 m", () => {
    // A 3000 m long run caps the easy runs at 3000 m, half of it 1500 m. 5000 m would be 2 runs of
    // 2500 m (13 min); one run at the cap holds 3000 m and the rest is not run.
    expect(fill({ restM: 5000, longM: 3000, qualityM: [] })).toEqual({
      easyRunsM: [3000],
      qualityPadM: [],
    });
    // 15 min each still fits twice in 5626 m: 2 runs of 2813 m.
    expect(fill({ restM: 5626, longM: 3000, qualityM: [] }).easyRunsM).toEqual([2813, 2813]);
    // Under 15 min nothing runs.
    expect(fill({ restM: 2812, longM: 3000, qualityM: [] }).easyRunsM).toEqual([]);
  });

  it("runs at the cap where the cap is under 15 min, and fewer days of it", () => {
    // A 2000 m long run caps the easy runs at 2000 m: 5000 m is 2 runs at the cap, not 3 of 1667 m.
    expect(fill({ restM: 5000, longM: 2000, qualityM: [] }).easyRunsM).toEqual([2000, 2000]);
  });

  it("keeps every easy day before the taper: equal runs of at least half the cap where 20 min runs would drop one", () => {
    // A 6-day down week at the 20 min floor: 18 475 m holds four 4625 m runs at most, so a taper week
    // would run 4 of its 5 easy days; a week before the taper runs all 5 at 3695 m.
    const downWeek = (keepDays: boolean) =>
      fill({
        restM: 18_475,
        longM: 4625,
        qualityM: [],
        easyDays: [WED, FRI, MON, 1, 3],
        minRunM: 4625,
        keepDays,
      }).easyRunsM;
    expect(downWeek(false)).toEqual([4619, 4619, 4619, 4618]);
    expect(downWeek(true)).toEqual([3695, 3695, 3695, 3695, 3695]);
  });

  it("drops an easy day before the taper only when even half the cap would not fit on each", () => {
    // Half of the 3750 m cap is 1875 m: 5 days need 9375 m.
    const shortWeek = (restM: number) =>
      fill({ restM, longM: 3750, qualityM: [], easyDays: [WED, FRI, MON, 1, 3], keepDays: true })
        .easyRunsM;
    expect(shortWeek(9375)).toEqual([1875, 1875, 1875, 1875, 1875]);
    expect(shortWeek(9374)).toEqual([3125, 3125, 3124]);
  });

  it("gives a rest under one short run to the quality sessions instead", () => {
    expect(
      fill({ restM: 6000, longM: 6000, qualityM: [4000], easyDays: [WED, FRI], minRunM: 3000 }),
    ).toEqual({
      easyRunsM: [],
      qualityPadM: [{ warmupM: 1200, cooldownM: 800 }],
    });
  });

  it("adds nothing when the quality sessions already take the rest", () => {
    expect(fill({ restM: 5000 })).toEqual({ easyRunsM: [], qualityPadM: [noPad] });
  });

  it("pads the quality sessions with everything when there is no easy day", () => {
    expect(fill({ restM: 20_000, longM: 6000, qualityM: [4000], easyDays: [] })).toEqual({
      easyRunsM: [],
      qualityPadM: [{ warmupM: 1200, cooldownM: 800 }],
    });
  });

  it("never passes the rest, a cap or the easy days, and leaves meters unrun only once every easy run is at its cap and another would be too short", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 150_000 }),
        fc.integer({ min: 2000, max: 30_000 }),
        fc.array(fc.integer({ min: 3000, max: 20_000 }), { maxLength: 2 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { maxLength: 5 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 52 }),
        fc.integer({ min: 1500, max: 5000 }),
        fc.integer({ min: 200, max: 600 }),
        fc.boolean(),
        (
          restM,
          longM,
          qualityM,
          easyDays,
          afterLongDay,
          weekNumber,
          minRunM,
          easyPaceSPerKm,
          keepDays,
        ) => {
          const { easyRunsM, qualityPadM } = fillWeek({
            restM,
            longM,
            qualityM,
            easyDays,
            afterLongDay,
            weekNumber,
            minRunM,
            easyPaceSPerKm,
            keepDays,
          });
          const capM = easyRunCapM({ longM, minRunM });
          const pads = qualityPadM.map((pad) => pad.warmupM + pad.cooldownM);
          const used = sum(qualityM) + sum(pads) + sum(easyRunsM);
          expect(used).toBeLessThanOrEqual(Math.max(restM, sum(qualityM)));
          expect(easyRunsM.length).toBeLessThanOrEqual(easyDays.length);
          easyRunsM.forEach((m) => {
            expect(Number.isInteger(m)).toBe(true);
            expect(m).toBeLessThanOrEqual(capM);
            expect(m).toBeGreaterThanOrEqual(Math.min(minRunM, Math.floor(capM / 2)));
          });
          const warmupMaxM =
            Math.floor((1500 * 1000) / easyPaceSPerKm) - Math.round((900 * 1000) / easyPaceSPerKm);
          const cooldownMaxM =
            Math.floor((1500 * 1000) / easyPaceSPerKm) - Math.round((600 * 1000) / easyPaceSPerKm);
          qualityPadM.forEach((pad, k) => {
            expect(pad.warmupM).toBeGreaterThanOrEqual(0);
            expect(pad.cooldownM).toBeGreaterThanOrEqual(0);
            expect(pad.warmupM).toBeLessThanOrEqual(warmupMaxM);
            expect(pad.cooldownM).toBeLessThanOrEqual(cooldownMaxM);
            expect(qualityM[k]! + pads[k]!).toBeLessThanOrEqual(Math.max(longM, qualityM[k]!));
          });
          // Overflow that fits under every cap is placed to the meter, the odd ones too.
          const overflowM = restM - sum(qualityM) - sum(easyRunsM);
          const fitsM = Math.min(
            warmupMaxM,
            cooldownMaxM,
            ...qualityM.map((meters) => longM - meters),
          );
          if (overflowM > 0 && qualityM.length > 0 && overflowM <= qualityM.length * fitsM) {
            expect(sum(pads)).toBe(overflowM);
          }
          expect(sum(pads)).toBeLessThanOrEqual(Math.max(0, overflowM));
          // Easy runs take everything they can hold first; meters go elsewhere only past their
          // caps, or where one more run would be under the shortest easy run: 15 min, or half the
          // cap when that is more, never over 20 min or the cap. Before the taper every easy day
          // runs while half the cap fits on each.
          const easyM = restM - sum(qualityM);
          const heldM = Math.min(easyM, easyDays.length * capM);
          const halfCapM = Math.min(minRunM, Math.floor(capM / 2));
          const floorM = Math.ceil((900 * 1000) / easyPaceSPerKm);
          const fewestM = Math.min(minRunM, capM, Math.max(halfCapM, floorM));
          const keepsAll = keepDays && easyM > 0 && easyM >= easyDays.length * halfCapM;
          if (keepsAll) {
            expect(easyRunsM).toHaveLength(easyDays.length);
            expect(sum(easyRunsM)).toBe(heldM);
          } else if (easyM > 0 && easyM >= fewestM) {
            easyRunsM.forEach((m) => expect(m).toBeGreaterThanOrEqual(fewestM));
            if (sum(easyRunsM) < heldM) {
              expect(easyRunsM).toEqual(easyRunsM.map(() => capM));
              expect((easyRunsM.length + 1) * fewestM).toBeGreaterThan(heldM);
            } else {
              expect(sum(easyRunsM)).toBe(heldM);
            }
          } else {
            expect(easyRunsM).toEqual([]);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
