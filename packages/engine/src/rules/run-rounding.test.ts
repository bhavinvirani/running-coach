import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { roundedRunM, roundedRunsM } from "./run-rounding";

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("run rounding", () => {
  it("rounds a run down to whole 500 m", () => {
    expect(roundedRunM(7499, 3750)).toBe(7000);
    expect(roundedRunM(7500, 3750)).toBe(7500);
    expect(roundedRunM(4000, 3750)).toBe(4000);
  });

  it("keeps a run whose 500 m step would be under 20 min as it is", () => {
    expect(roundedRunM(3999, 3750)).toBe(3999);
    expect(roundedRunM(3750, 3750)).toBe(3750);
    expect(roundedRunM(3000, 3750)).toBe(3000);
  });

  it("rounds the week's easy runs down and lets the longest carry what they gave up, so the week stays exact", () => {
    // 300 + 200 + 100 m come off; the 7300 m run takes them: 7000 + 600 m.
    expect(roundedRunsM({ runsM: [5200, 7300, 4100], capM: 8000, minRunM: 3750 })).toEqual([
      5000, 7600, 4000,
    ]);
  });

  it("rounds the week when the longest lands exactly on its cap and leaves it as it is 1 m over", () => {
    expect(roundedRunsM({ runsM: [7300, 5400], capM: 7700, minRunM: 3750 })).toEqual([7700, 5000]);
    expect(roundedRunsM({ runsM: [7300, 5401], capM: 7700, minRunM: 3750 })).toEqual([7300, 5401]);
  });

  it("carries the remainder on the first of equal longest runs and rounds nothing in an empty week", () => {
    expect(roundedRunsM({ runsM: [6200, 6200], capM: 8000, minRunM: 3750 })).toEqual([6400, 6000]);
    expect(roundedRunsM({ runsM: [], capM: 8000, minRunM: 3750 })).toEqual([]);
  });

  it("keeps a run at 20 min as it is and carries the others' remainder on the longest", () => {
    expect(roundedRunsM({ runsM: [3750, 6300], capM: 8000, minRunM: 3750 })).toEqual([3750, 6300]);
    expect(roundedRunsM({ runsM: [3750, 6300, 4200], capM: 8000, minRunM: 3750 })).toEqual([
      3750, 6500, 4000,
    ]);
  });

  it("keeps the week's total and every run under the cap, rounding every run but the longest or none", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20_000 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 1500, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (runsM, minRunM, headroomM) => {
          const capM = Math.max(...runsM) + headroomM;
          const rounded = roundedRunsM({ runsM, capM, minRunM });
          expect(sum(rounded)).toBe(sum(runsM));
          const longest = runsM.indexOf(Math.max(...runsM));
          rounded.forEach((m, k) => {
            expect(m).toBeLessThanOrEqual(capM);
            if (k !== longest && m !== runsM[k]) {
              expect(m % 500).toBe(0);
              expect(m).toBeGreaterThanOrEqual(minRunM);
            }
          });
          // Rounded or not, the longest stays the longest.
          expect(Math.max(...rounded)).toBe(rounded[longest]);
        },
      ),
      { numRuns: 500 },
    );
  });
});
