import {
  DISTANCE_METERS,
  distanceKeySchema,
  GPS_GLITCH_PACE_S_PER_KM,
  METERS_PER_KM,
  type DistanceKey,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GLITCH_WINDOW_S } from "../constants";
import { bestEfforts, type BestEffort, type BestEffortsInput } from "./best-efforts";

const GLITCH_SPEED = METERS_PER_KM / GPS_GLITCH_PACE_S_PER_KM;
// Float slack for sums over thousands of samples; far below the 0.15 s that matters against Garmin.
const EPS = 1e-6;

/** A run sampled every `stepS` seconds from meters gained in each step. */
function fromSteps(stepsM: readonly number[], stepS = 1): BestEffortsInput {
  const elapsedS = [0];
  const distanceM = [0];
  stepsM.forEach((stepM, k) => {
    elapsedS.push((k + 1) * stepS);
    distanceM.push(distanceM[k]! + stepM);
  });
  return { elapsedS, distanceM };
}

/** Steps for each phase at a steady speed; durations are whole multiples of `stepS`. */
function phases(parts: readonly { speed: number; durationS: number }[], stepS = 1): number[] {
  return parts.flatMap(({ speed, durationS }) =>
    Array.from({ length: durationS / stepS }, () => speed * stepS),
  );
}

/** Products, not sums, so constant-pace distances carry no accumulated float error. */
function constantPace(speed: number, durationS: number, stepS = 1): BestEffortsInput {
  const n = durationS / stepS;
  return {
    elapsedS: Array.from({ length: n + 1 }, (_, k) => k * stepS),
    distanceM: Array.from({ length: n + 1 }, (_, k) => k * stepS * speed),
  };
}

function effortAt(efforts: readonly BestEffort[], key: DistanceKey): BestEffort | undefined {
  return efforts.find((effort) => effort.distanceKey === key);
}

function keysOf(efforts: readonly BestEffort[]): DistanceKey[] {
  return efforts.map((effort) => effort.distanceKey);
}

function endOf(effort: BestEffort): number {
  return effort.startS + effort.timeS;
}

/** A copy with sample `index` set to the given time and distance. */
function withSample(
  input: BestEffortsInput,
  index: number,
  elapsedS: number,
  distanceM: number,
): BestEffortsInput {
  return {
    elapsedS: input.elapsedS.map((t, k) => (k === index ? elapsedS : t)),
    distanceM: input.distanceM.map((d, k) => (k === index ? distanceM : d)),
  };
}

/** A copy with one sample inserted after `index`, every later distance moved on by `jumpM`. */
function withZeroTimeStep(input: BestEffortsInput, index: number, jumpM: number): BestEffortsInput {
  const elapsedS = [...input.elapsedS];
  const distanceM = input.distanceM.map((d, k) => (k > index ? d + jumpM : d));
  elapsedS.splice(index + 1, 0, input.elapsedS[index]!);
  distanceM.splice(index + 1, 0, input.distanceM[index]! + jumpM);
  return { elapsedS, distanceM };
}

// Hundredths drawn as integers: fc.double leans to extremes (1e-300, the bounds) that no run has.
function hundredths(min: number, max: number): fc.Arbitrary<number> {
  return fc.integer({ min: min * 100, max: max * 100 }).map((n) => n / 100);
}

// One-second rows like Garmin's at maxchart 10000. size "max" because fast-check's default size
// keeps arrays near 10 rows, too short to reach 1 km.
const easyStepM = fc.oneof(
  { weight: 30, arbitrary: hundredths(1.5, 6) },
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: hundredths(6, 60) },
);
const easySteps = fc.array(easyStepM, { minLength: 200, maxLength: 4000, size: "max" });
const fastSteps = fc.array(hundredths(5, 10), { minLength: 200, maxLength: 2500, size: "max" });
// Distance flat between catch-ups whose 10 s windows sit near the glitch speed, so efforts come
// close to the bound that a window allows.
const stallSteps = fc
  .tuple(fc.integer({ min: 1, max: 12 }), hundredths(6, 9), fc.integer({ min: 200, max: 3000 }))
  .map(([periodS, speed, length]) =>
    Array.from({ length }, (_, k) => (k % periodS === periodS - 1 ? speed * periodS : 0)),
  );
const oneSecondSteps = fc.oneof(easySteps, fastSteps, stallSteps);
const oneSecondRun = oneSecondSteps.map((steps) => fromSteps(steps));

// Uneven sampling with repeated timestamps and the odd spike, non-decreasing in time and distance.
const unevenRun = fc
  .array(
    fc.tuple(
      fc.oneof(
        { weight: 10, arbitrary: fc.constant(1) },
        { weight: 3, arbitrary: hundredths(0, 3) },
        { weight: 1, arbitrary: fc.constant(0) },
      ),
      hundredths(1.5, 6),
      fc.oneof(
        { weight: 30, arbitrary: fc.constant(0) },
        { weight: 1, arbitrary: hundredths(0, 40) },
      ),
    ),
    { minLength: 200, maxLength: 3000, size: "max" },
  )
  .map((rows) => {
    const elapsedS = [0];
    const distanceM = [0];
    rows.forEach(([dtS, speed, spikeM], k) => {
      elapsedS.push(elapsedS[k]! + dtS);
      distanceM.push(distanceM[k]! + dtS * speed + spikeM);
    });
    return { elapsedS, distanceM };
  });

// What a broken feed could send: an uneven run with some samples made non-finite or moved back.
const corruption = fc.record({
  at: fc.nat(),
  field: fc.constantFrom("elapsedS", "distanceM"),
  value: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -50),
});
const messyRun = fc
  .tuple(unevenRun, fc.array(corruption, { maxLength: 6 }))
  .map(([run, corruptions]) => {
    const messy = { elapsedS: [...run.elapsedS], distanceM: [...run.distanceM] };
    for (const { at, field, value } of corruptions) {
      const k = at % messy[field].length;
      // -50 moves the sample back, so time or distance goes backwards into it and forwards out.
      messy[field][k] = value === -50 ? messy[field][k]! - 50 : value;
    }
    return messy;
  });

describe("best efforts", () => {
  it("gives D / v at every distance of a marathon-plus run at constant pace", () => {
    const efforts = bestEfforts(constantPace(3.125, 14_000));
    expect(keysOf(efforts)).toEqual(distanceKeySchema.options);
    for (const effort of efforts) {
      expect(effort.timeS).toBeCloseTo(DISTANCE_METERS[effort.distanceKey] / 3.125, 6);
    }
  });

  it("gives only the distances a run reaches: 11.25 km reaches 10K but not 15K", () => {
    expect(keysOf(bestEfforts(constantPace(3.125, 3600)))).toEqual([
      "1k",
      "1mi",
      "2mi",
      "5k",
      "5mi",
      "10k",
    ]);
  });

  it("gives a run of exactly 5000 m a 5K effort equal to its whole time", () => {
    const run = constantPace(3.125, 1600);
    expect(run.distanceM.at(-1)).toBe(5000);
    expect(effortAt(bestEfforts(run), "5k")).toEqual({ distanceKey: "5k", timeS: 1600, startS: 0 });
  });

  it("gives a run of 4999.9 m no 5K effort", () => {
    const exact = constantPace(3.125, 1600);
    const run = withSample(exact, 1600, 1600, 4999.9);
    const efforts = bestEfforts(run);
    expect(effortAt(efforts, "5k")).toBeUndefined();
    expect(keysOf(efforts)).toEqual(["1k", "1mi", "2mi"]);
  });

  it("takes the 5K of a negative-split run from the faster second half", () => {
    const run = fromSteps(
      phases([
        { speed: 2.5, durationS: 2000 },
        { speed: 3.125, durationS: 1600 },
      ]),
    );
    const fiveK = effortAt(bestEfforts(run), "5k")!;
    expect(fiveK.timeS).toBeCloseTo(1600, 9);
    expect(fiveK.startS).toBeCloseTo(2000, 9);
  });

  it("finds the window whose end falls between samples (2 s samples)", () => {
    // 1008 m at 4 m/s between slower stretches; the best mile starts at the fast stretch and ends
    // 601.344 m into the 3 m/s stretch after it, 200.448 s in, which is not on a 2 s sample.
    const run = fromSteps(
      phases(
        [
          { speed: 2.5, durationS: 400 },
          { speed: 4, durationS: 252 },
          { speed: 3, durationS: 800 },
        ],
        2,
      ),
      2,
    );
    const efforts = bestEfforts(run);
    const mile = effortAt(efforts, "1mi")!;
    expect(mile.timeS).toBeCloseTo(252 + (1609.344 - 1008) / 3, 9);
    expect(mile.startS).toBeCloseTo(400, 9);
    expect(endOf(mile) % 2).toBeCloseTo(0.448, 9);
    expect(effortAt(efforts, "1k")!.timeS).toBeCloseTo(250, 9);
  });

  it("interpolates at constant pace on 2 s samples instead of snapping to a sample", () => {
    const oneK = effortAt(bestEfforts(constantPace(3, 1200, 2)), "1k")!;
    expect(oneK.timeS).toBeCloseTo(1000 / 3, 9);
  });

  it("splits a run at a 300 m jump in 3 s: no effort spans it and both sides give their own", () => {
    // Left of the jump: 3500 m at 3.5 m/s. Right: 6600 m at 3 m/s. Joined they would reach 10K.
    const run = fromSteps([
      ...phases([{ speed: 3.5, durationS: 1000 }]),
      100,
      100,
      100,
      ...phases([{ speed: 3, durationS: 2200 }]),
    ]);
    const efforts = bestEfforts(run);
    for (const effort of efforts) {
      expect(endOf(effort) <= 1000 + EPS || effort.startS >= 1003 - EPS).toBe(true);
    }
    expect(keysOf(efforts)).toEqual(["1k", "1mi", "2mi", "5k"]);
    expect(endOf(effortAt(efforts, "2mi")!)).toBeLessThanOrEqual(1000);
    expect(effortAt(efforts, "1k")!.timeS).toBeCloseTo(1000 / 3.5, 6);
    const fiveK = effortAt(efforts, "5k")!;
    expect(fiveK.startS).toBeGreaterThanOrEqual(1003);
    expect(fiveK.timeS).toBeCloseTo(5000 / 3, 6);
  });

  it("keeps the stall-then-catch-up pattern (4 s flat, then +25 m in 1 s) so a 10K across it exists", () => {
    // Garmin counts this run and its records include it; a one-sample check would cut it.
    expect(25).toBeGreaterThan(GLITCH_SPEED);
    const run = fromSteps([
      ...phases([{ speed: 2.9, durationS: 1800 }]),
      0,
      0,
      0,
      0,
      25,
      ...phases([{ speed: 2.9, durationS: 1800 }]),
    ]);
    const tenK = effortAt(bestEfforts(run), "10k")!;
    expect(tenK.startS).toBeLessThan(1800);
    expect(endOf(tenK)).toBeGreaterThan(1805);
  });

  it("cuts where distance goes backwards and takes the effort from the faster side", () => {
    const run = fromSteps([
      ...phases([{ speed: 3, durationS: 2000 }]),
      -50,
      ...phases([{ speed: 3.2, durationS: 2000 }]),
    ]);
    const efforts = bestEfforts(run);
    expect(effortAt(efforts, "10k")).toBeUndefined();
    const fiveK = effortAt(efforts, "5k")!;
    expect(fiveK.startS).toBeGreaterThanOrEqual(2001);
    expect(fiveK.timeS).toBeCloseTo(5000 / 3.2, 6);
  });

  it("cuts where time goes backwards", () => {
    const left = constantPace(3, 2000);
    const run = {
      elapsedS: [...left.elapsedS, ...Array.from({ length: 2001 }, (_, k) => 1995 + k)],
      distanceM: [...left.distanceM, ...Array.from({ length: 2001 }, (_, k) => 6003 + 3 * k)],
    };
    const efforts = bestEfforts(run);
    expect(effortAt(efforts, "10k")).toBeUndefined();
    expect(effortAt(efforts, "5k")!.timeS).toBeCloseTo(5000 / 3, 6);
  });

  it.each([
    ["distance NaN", 2000, Number.NaN],
    ["distance +Infinity", 2000, Number.POSITIVE_INFINITY],
    ["time NaN", Number.NaN, 6000],
    ["time -Infinity", Number.NEGATIVE_INFINITY, 6000],
  ])("skips a sample with %s and cuts the run there", (_label, elapsedS, distanceM) => {
    const run = withSample(constantPace(3, 4000), 2000, elapsedS, distanceM);
    const efforts = bestEfforts(run);
    expect(effortAt(efforts, "10k")).toBeUndefined();
    expect(effortAt(efforts, "5k")!.timeS).toBeCloseTo(5000 / 3, 6);
  });

  it("skips non-finite samples at the start and several in a row, using the runs around them", () => {
    let run = constantPace(3, 4000);
    for (const k of [0, 1, 2000, 2001, 2002]) run = withSample(run, k, Number.NaN, Number.NaN);
    const efforts = bestEfforts(run);
    expect(effortAt(efforts, "10k")).toBeUndefined();
    const fiveK = effortAt(efforts, "5k")!;
    expect(fiveK.timeS).toBeCloseTo(5000 / 3, 6);
    expect(fiveK.startS).toBeGreaterThanOrEqual(2);
  });

  it("keeps a zero-time interval with a small distance step outside any glitch window", () => {
    const run = withZeroTimeStep(constantPace(3, 3500), 1750, 2);
    expect(effortAt(bestEfforts(run), "10k")).toBeDefined();
  });

  it("cuts at a zero-time interval whose distance step makes its window a glitch", () => {
    const run = withZeroTimeStep(constantPace(3, 3500), 1750, 100);
    expect(effortAt(bestEfforts(run), "10k")).toBeUndefined();
  });

  it("leaves out a distance whose span equals the segment only up to float rounding, never giving Infinity", () => {
    // 30120.94 - 10120.94 passes a ">= 20000" check, yet 10120.94 + 20000 > 30120.94 in floats, so neither
    // sweep finds a window; the distance must be left out, not returned as an infinite time.
    const efforts = bestEfforts({ elapsedS: [0, 6000], distanceM: [10120.94, 30120.94] });
    expect(efforts.every((effort) => Number.isFinite(effort.timeS))).toBe(true);
    expect(efforts.map((effort) => effort.distanceKey)).not.toContain("20k");
  });

  it("returns the efforts sorted shortest distance first", () => {
    const meters = bestEfforts(constantPace(3.125, 14_000)).map(
      (effort) => DISTANCE_METERS[effort.distanceKey],
    );
    expect(meters).toHaveLength(11);
    expect(meters).toEqual([...meters].sort((a, b) => a - b));
  });

  it("returns nothing for an empty run or a single sample", () => {
    expect(bestEfforts({ elapsedS: [], distanceM: [] })).toEqual([]);
    expect(bestEfforts({ elapsedS: [0], distanceM: [0] })).toEqual([]);
  });

  it("rejects mismatched array lengths as a programmer error", () => {
    expect(() => bestEfforts({ elapsedS: [0, 1], distanceM: [0] })).toThrow(RangeError);
  });

  it("gives the same output for the same input (deterministic)", () => {
    fc.assert(
      fc.property(fc.oneof(oneSecondRun, unevenRun, messyRun), (run) => {
        const copy = { elapsedS: [...run.elapsedS], distanceM: [...run.distanceM] };
        expect(bestEfforts(copy)).toEqual(bestEfforts(run));
      }),
    );
  });

  it("never gives a longer distance less time than a shorter one", () => {
    fc.assert(
      fc.property(fc.oneof(oneSecondRun, unevenRun, messyRun), (run) => {
        const efforts = bestEfforts(run);
        for (let k = 1; k < efforts.length; k++) {
          expect(efforts[k]!.timeS).toBeGreaterThanOrEqual(efforts[k - 1]!.timeS - EPS);
        }
      }),
    );
  });

  it("keeps every effort inside the run, with a positive time", () => {
    fc.assert(
      fc.property(fc.oneof(oneSecondRun, unevenRun), (run) => {
        const lastS = run.elapsedS.at(-1) ?? 0;
        for (const effort of bestEfforts(run)) {
          expect(effort.startS).toBeGreaterThanOrEqual(0);
          expect(effort.timeS).toBeGreaterThan(0);
          expect(endOf(effort)).toBeLessThanOrEqual(lastS + EPS);
        }
      }),
    );
  });

  it("never gives an effort faster than the glitch speed allows, give or take one window", () => {
    fc.assert(
      fc.property(oneSecondRun, (run) => {
        for (const effort of bestEfforts(run)) {
          expect(
            effort.timeS * GLITCH_SPEED + GLITCH_SPEED * GLITCH_WINDOW_S,
          ).toBeGreaterThanOrEqual(DISTANCE_METERS[effort.distanceKey] - EPS);
        }
      }),
    );
  });

  it("never lets an effort span an inserted glitch jump", () => {
    const withJump = oneSecondSteps
      .filter((steps) => steps.length > 0)
      .chain((steps) =>
        fc.nat({ max: steps.length - 1 }).map((at) => ({
          at,
          run: fromSteps(steps.map((stepM, k) => (k === at ? stepM + 300 : stepM))),
        })),
      );
    fc.assert(
      fc.property(withJump, ({ at, run }) => {
        for (const effort of bestEfforts(run)) {
          expect(endOf(effort) <= at + EPS || effort.startS >= at + 1 - EPS).toBe(true);
        }
      }),
    );
  });
});
