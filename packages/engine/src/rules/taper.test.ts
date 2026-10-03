import { raceDistanceKeySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween } from "../dates";
import { taperBlocks, taperPeakM, taperStartDate, taperVolumesM } from "./taper";

const START = "2026-10-05"; // a Monday

describe("taper", () => {
  it("starts the taper 14 days before a 10K and 21 days before a marathon", () => {
    expect(taperStartDate({ distanceKey: "10k", raceDate: "2026-12-20" })).toBe("2026-12-06");
    expect(taperStartDate({ distanceKey: "marathon", raceDate: "2026-12-20" })).toBe("2026-11-29");
  });

  it("counts a Sunday 10K's blocks back from race day: Sunday to Saturday, the race excluded", () => {
    expect(taperBlocks({ distanceKey: "10k", raceDate: "2026-12-20", startDate: START })).toEqual([
      { number: 2, firstDate: "2026-12-06", lastDate: "2026-12-12" },
      { number: 1, firstDate: "2026-12-13", lastDate: "2026-12-19" },
    ]);
  });

  it("makes a Monday race's blocks the two whole weeks before it and a Thursday race's Thursday to Wednesday", () => {
    expect(taperBlocks({ distanceKey: "half", raceDate: "2026-12-21", startDate: START })).toEqual([
      { number: 2, firstDate: "2026-12-07", lastDate: "2026-12-13" },
      { number: 1, firstDate: "2026-12-14", lastDate: "2026-12-20" },
    ]);
    expect(taperBlocks({ distanceKey: "half", raceDate: "2026-12-24", startDate: START })).toEqual([
      { number: 2, firstDate: "2026-12-10", lastDate: "2026-12-16" },
      { number: 1, firstDate: "2026-12-17", lastDate: "2026-12-23" },
    ]);
  });

  it("gives a marathon 3 blocks", () => {
    expect(
      taperBlocks({ distanceKey: "marathon", raceDate: "2026-12-20", startDate: START }).map(
        (block) => [block.number, block.firstDate],
      ),
    ).toEqual([
      [3, "2026-11-29"],
      [2, "2026-12-06"],
      [1, "2026-12-13"],
    ]);
  });

  it("cuts a block at the plan's first day and drops one wholly before it: a Sunday race 13 days out", () => {
    expect(
      taperBlocks({ distanceKey: "5k", raceDate: addDays(START, 13), startDate: START }),
    ).toEqual([
      { number: 2, firstDate: START, lastDate: addDays(START, 5) },
      { number: 1, firstDate: addDays(START, 6), lastDate: addDays(START, 12) },
    ]);
    expect(
      taperBlocks({ distanceKey: "5k", raceDate: addDays(START, 7), startDate: START }),
    ).toEqual([{ number: 1, firstDate: START, lastDate: addDays(START, 6) }]);
  });

  it("has no blocks for a race on the plan's first day", () => {
    expect(taperBlocks({ distanceKey: "10k", raceDate: START, startDate: START })).toEqual([]);
  });

  it("steps a 2-week taper to 65% then 40% of the peak in the 7 days before the race, a 60% cut", () => {
    expect(taperVolumesM({ distanceKey: "10k", peakVolumeM: 40_000, blocks: 2 })).toEqual([
      26_000, 16_000,
    ]);
  });

  it("steps a 3-week marathon taper to 80%, 60% and 40% of the peak", () => {
    expect(taperVolumesM({ distanceKey: "marathon", peakVolumeM: 72_000, blocks: 3 })).toEqual([
      57_600, 43_200, 28_800,
    ]);
  });

  it("keeps the last blocks, counted back from the race, when fewer fit", () => {
    expect(taperVolumesM({ distanceKey: "marathon", peakVolumeM: 72_000, blocks: 2 })).toEqual([
      43_200, 28_800,
    ]);
    expect(taperVolumesM({ distanceKey: "5k", peakVolumeM: 40_000, blocks: 1 })).toEqual([16_000]);
  });

  it("rounds up to whole meters so the last block never cuts more than 60%: 1 m over 40% of the peak", () => {
    // 40% of 40_001 m is 16_000.4 m; 16_000 m would be a 60.001% cut.
    expect(taperVolumesM({ distanceKey: "5k", peakVolumeM: 40_001, blocks: 1 })).toEqual([16_001]);
    expect(taperVolumesM({ distanceKey: "half", peakVolumeM: 56_003, blocks: 2 })).toEqual([
      36_402, 22_402,
    ]);
  });

  it.each([0, 3])("rejects %s blocks for a 2-week taper as a programmer error", (blocks) => {
    expect(() => taperVolumesM({ distanceKey: "5k", peakVolumeM: 40_000, blocks })).toThrow(
      RangeError,
    );
  });

  it("cuts from the largest whole week before the taper, a down week's neighbour too, else the start volume", () => {
    expect(taperPeakM({ weeksM: [50_000, 40_000, 46_000], startVolumeM: 20_000 })).toBe(50_000);
    expect(taperPeakM({ weeksM: [], startVolumeM: 20_000 })).toBe(20_000);
  });

  it("lays consecutive blocks of at most 7 days, the last ending the day before the race, none before the start", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 400 }),
        (distanceKey, daysOut) => {
          const raceDate = addDays(START, daysOut);
          const taperDays = distanceKey === "marathon" ? 21 : 14;
          const blocks = taperBlocks({ distanceKey, raceDate, startDate: START });
          expect(blocks).toHaveLength(Math.min(taperDays / 7, Math.ceil(daysOut / 7)));
          blocks.forEach((block, k) => {
            expect(block.number).toBe(blocks.length - k);
            expect(daysBetween(START, block.firstDate)).toBeGreaterThanOrEqual(0);
            expect(daysBetween(block.firstDate, block.lastDate)).toBeLessThanOrEqual(6);
            expect(daysBetween(block.lastDate, raceDate)).toBe(7 * block.number - 6);
            if (k > 0) expect(daysBetween(blocks[k - 1]!.lastDate, block.firstDate)).toBe(1);
          });
          if (blocks.length > 0) {
            expect(daysBetween(blocks[0]!.firstDate, raceDate)).toBe(Math.min(taperDays, daysOut));
          }
          expect(daysBetween(taperStartDate({ distanceKey, raceDate }), raceDate)).toBe(taperDays);
        },
      ),
    );
  });

  it("cuts every block to between 40% and 80% of the peak, the last to 40-60%, never rising", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 10_000, max: 150_000 }),
        fc.integer({ min: 1, max: 3 }),
        (distanceKey, peakVolumeM, wanted) => {
          const blocks = Math.min(wanted, distanceKey === "marathon" ? 3 : 2);
          const volumes = taperVolumesM({ distanceKey, peakVolumeM, blocks });
          expect(volumes).toHaveLength(blocks);
          volumes.forEach((m, k) => {
            expect(Number.isInteger(m)).toBe(true);
            expect(m).toBeGreaterThanOrEqual(peakVolumeM * 0.4);
            // Whole meters rounded up: at most 1 m over the 80% share.
            expect(m).toBeLessThanOrEqual(Math.ceil(peakVolumeM * 0.8));
            if (k > 0) expect(m).toBeLessThanOrEqual(volumes[k - 1]!);
          });
          const last = volumes.at(-1)!;
          expect(last).toBeGreaterThanOrEqual(peakVolumeM * 0.4);
          expect(last).toBeLessThanOrEqual(peakVolumeM * 0.6);
        },
      ),
    );
  });
});
