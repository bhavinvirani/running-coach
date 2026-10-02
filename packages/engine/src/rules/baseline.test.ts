import { raceDistanceKeySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recentVolumeM, startVolume } from "./baseline";

const FLOOR = { "5k": 15_000, "10k": 20_000, half: 25_000, marathon: 30_000 } as const;

function baseline(weeklyVolumesM: number[], daysSinceLastRun: number | null) {
  return { weeklyVolumesM, longestRunM: 10_000, daysSinceLastRun };
}

describe("baseline", () => {
  it("averages only the weeks with running", () => {
    expect(recentVolumeM([10_000, 0, 20_000, 0])).toBe(15_000);
    expect(recentVolumeM([30_000, 30_000, 30_000, 30_000])).toBe(30_000);
  });

  it("gives 0 when no baseline week has running", () => {
    expect(recentVolumeM([0, 0, 0, 0])).toBe(0);
  });

  it("starts at recent volume when the last run was under 7 days ago", () => {
    expect(
      startVolume({ baseline: baseline([40_000, 40_000, 40_000, 40_000], 3), distanceKey: "5k" }),
    ).toEqual({
      startVolumeM: 40_000,
      warning: null,
    });
  });

  it("starts at 70% after 7 days off and 50% after 14, never under the distance's floor", () => {
    const weeks = [40_000, 40_000, 40_000, 40_000];
    expect(startVolume({ baseline: baseline(weeks, 7), distanceKey: "5k" }).startVolumeM).toBe(
      28_000,
    );
    expect(startVolume({ baseline: baseline(weeks, 14), distanceKey: "5k" }).startVolumeM).toBe(
      20_000,
    );
    expect(startVolume({ baseline: baseline(weeks, 14), distanceKey: "half" }).startVolumeM).toBe(
      25_000,
    );
  });

  it("uses the floor 1 m under it, the volume at it and 1 m over it", () => {
    const at = (m: number) =>
      startVolume({ baseline: baseline([m, m, m, m], 0), distanceKey: "10k" }).startVolumeM;
    expect(at(19_999)).toBe(20_000);
    expect(at(20_000)).toBe(20_000);
    expect(at(20_001)).toBe(20_001);
  });

  it("warns no_recent_runs from the floor when every baseline week is 0", () => {
    expect(startVolume({ baseline: baseline([0, 0, 0, 0], 40), distanceKey: "marathon" })).toEqual({
      startVolumeM: 30_000,
      warning: { code: "no_recent_runs", startVolumeM: 30_000 },
    });
  });

  it("starts a runner with no runs on record at the floor without the warning when weeks have volume", () => {
    expect(startVolume({ baseline: baseline([12_000, 0, 0, 0], null), distanceKey: "5k" })).toEqual(
      {
        startVolumeM: 15_000,
        warning: null,
      },
    );
  });

  it("starts at a whole meter between the floor and recent volume, warning exactly when every week is 0", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.array(fc.nat({ max: 120_000 }), { minLength: 4, maxLength: 4 }),
        fc.option(fc.nat({ max: 60 })),
        (distanceKey, weeklyVolumesM, daysSinceLastRun) => {
          const { startVolumeM, warning } = startVolume({
            baseline: baseline(weeklyVolumesM, daysSinceLastRun),
            distanceKey,
          });
          expect(Number.isInteger(startVolumeM)).toBe(true);
          expect(startVolumeM).toBeGreaterThanOrEqual(FLOOR[distanceKey]);
          expect(startVolumeM).toBeLessThanOrEqual(
            Math.max(FLOOR[distanceKey], recentVolumeM(weeklyVolumesM)),
          );
          expect(warning !== null).toBe(weeklyVolumesM.every((m) => m === 0));
        },
      ),
    );
  });
});
