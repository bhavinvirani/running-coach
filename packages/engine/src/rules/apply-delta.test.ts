import {
  sessionStepsSchema,
  type PlanPaces,
  type SessionSteps,
  type SessionType,
  type Step,
} from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyDelta, sameSession, type AdjustedSession, type DeltaSession } from "./apply-delta";
import { sessionTarget } from "./session-target";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // midpoint 320 s/km: 20 min is 3750 m
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 }, // midpoint 255 s/km
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 223 },
  race: { fastSPerKm: 236, slowSPerKm: 244 },
};

const byTime = (kind: Step["kind"], zone: Step["zone"], durationS: number): Step => ({
  kind,
  zone,
  distanceM: null,
  durationS,
});
const easyRun = (distanceM: number): SessionSteps => [
  { kind: "run", zone: "easy", distanceM, durationS: null },
];
// 2813 + 3000 + 1875 m and 900 + 765 + 600 s: 7688 m in 2265 s.
const TEMPO: SessionSteps = [
  byTime("warmup", "easy", 900),
  { kind: "work", zone: "threshold", distanceM: 3000, durationS: null },
  byTime("cooldown", "easy", 600),
];

// 16 000 m easy in 5120 s and a 4000 m finish at the 270.5 s/km marathon midpoint in 1082 s.
const FINISH: SessionSteps = [
  { kind: "run", zone: "easy", distanceM: 16_000, durationS: null },
  { kind: "run", zone: "marathon", distanceM: 4000, durationS: null },
];
// 6000 m easy and 6 strides of 20 s with a 60 s jog: 7674 m in 2400 s.
const STRIDES: SessionSteps = [
  { kind: "run", zone: "easy", distanceM: 6000, durationS: null },
  {
    repeat: 6,
    steps: [byTime("run", "repetition", 20), byTime("recovery", "easy", 60)],
  },
];

function session(type: SessionType, steps: SessionSteps): DeltaSession {
  return {
    date: "2026-10-08",
    type,
    status: "planned",
    source: "plan",
    title: null,
    steps,
    target: sessionTarget(steps, PACES),
  };
}

describe("apply delta", () => {
  it("rests a session: skipped, its steps and target as they were", () => {
    const tempo = session("tempo", TEMPO);
    expect(applyDelta(tempo, { kind: "rest" }, PACES)).toEqual({
      type: "tempo",
      title: null,
      status: "skipped",
      steps: TEMPO,
      target: tempo.target,
    });
  });

  it("turns a tempo into an easy run of the same time, floored to 100 m", () => {
    // 2265 s at 320 s/km is 7078 m, floored to 7000.
    expect(applyDelta(session("tempo", TEMPO), { kind: "easy" }, PACES)).toEqual({
      type: "easy",
      title: null,
      status: "planned",
      steps: easyRun(7000),
      target: { distanceM: 7000, durationS: 2240, zone: "easy" },
    });
  });

  it("keeps the easy run at least 20 min, but never longer than the session it replaces", () => {
    const short: SessionSteps = [
      byTime("warmup", "easy", 300),
      { kind: "work", zone: "threshold", distanceM: 1200, durationS: null },
    ];
    // 300 + 306 s, 938 + 1200 m: 20 min easy would be 3750 m, longer than the session.
    expect(applyDelta(session("tempo", short), { kind: "easy" }, PACES).steps).toEqual(
      easyRun(2138),
    );
    const longer: SessionSteps = [
      byTime("warmup", "easy", 600),
      { kind: "work", zone: "threshold", distanceM: 3000, durationS: null },
    ];
    // 600 + 765 s at 320 s/km is 4265 m: floored to 4200, above the minimum.
    expect(applyDelta(session("tempo", longer), { kind: "easy" }, PACES).steps).toEqual(
      easyRun(4200),
    );
    const minimum: SessionSteps = [
      byTime("warmup", "easy", 600),
      { kind: "work", zone: "repetition", distanceM: 2000, durationS: null },
    ];
    // 600 + 439 s at 320 s/km is 3246 m, under 20 min: the run is 3750 m of the 3875 m session.
    expect(applyDelta(session("intervals", minimum), { kind: "easy" }, PACES).steps).toEqual(
      easyRun(3750),
    );
  });

  it("turns a long run with a marathon-pace finish into one plain easy run of its time", () => {
    // 6202 s at 320 s/km is 19 381 m, floored to 19 300.
    expect(applyDelta(session("long", FINISH), { kind: "easy" }, PACES)).toEqual({
      type: "easy",
      title: null,
      status: "planned",
      steps: easyRun(19_300),
      target: { distanceM: 19_300, durationS: 6176, zone: "easy" },
    });
  });

  it("cuts an easy run with strides to one plain easy run and sums the new target", () => {
    // 7674 m at 0.8 is 6139 m, floored to 6100.
    expect(applyDelta(session("easy", STRIDES), { kind: "scale", factor: 0.8 }, PACES)).toEqual({
      type: "easy",
      title: null,
      status: "planned",
      steps: easyRun(6100),
      target: { distanceM: 6100, durationS: 1952, zone: "easy" },
    });
  });

  it("scales the steps by the factor and sums the new target", () => {
    expect(
      applyDelta(session("easy", easyRun(8000)), { kind: "scale", factor: 0.8 }, PACES),
    ).toEqual({
      type: "easy",
      title: null,
      status: "planned",
      steps: easyRun(6400),
      target: { distanceM: 6400, durationS: 2048, zone: "easy" },
    });
  });

  it("keeps a session's title and status through a scale", () => {
    const named = {
      ...session("easy", easyRun(8000)),
      title: "Walk-run",
      status: "moved" as const,
    };
    expect(applyDelta(named, { kind: "scale", factor: 0.5 }, PACES)).toMatchObject({
      title: "Walk-run",
      status: "moved",
    });
  });

  it("tells a session from its change by type, title, status and steps", () => {
    const base: AdjustedSession = {
      type: "easy",
      title: null,
      status: "planned",
      steps: easyRun(8000),
      target: sessionTarget(easyRun(8000), PACES),
    };
    expect(sameSession(base, { ...base, steps: easyRun(8000) })).toBe(true);
    expect(sameSession(base, { ...base, type: "long" })).toBe(false);
    expect(sameSession(base, { ...base, title: "Walk-run" })).toBe(false);
    expect(sameSession(base, { ...base, status: "skipped" })).toBe(false);
    expect(sameSession(base, { ...base, steps: easyRun(8100) })).toBe(false);
    expect(sameSession(base, { ...base, steps: [...easyRun(8000), ...easyRun(8000)] })).toBe(false);
  });

  it("compares walk-run rounds field by field, whatever order jsonb gave the keys", () => {
    const rounds = (repeat: number, runS = 240): SessionSteps => [
      { repeat, steps: [byTime("run", "easy", runS), byTime("recovery", "easy", 60)] },
    ];
    const walkRun = (steps: SessionSteps): AdjustedSession => ({
      type: "easy",
      title: "Walk-run",
      status: "planned",
      steps,
      target: sessionTarget(steps, PACES),
    });
    const reordered: SessionSteps = [
      {
        steps: [
          { durationS: 240, distanceM: null, zone: "easy", kind: "run" },
          { durationS: 60, distanceM: null, zone: "easy", kind: "recovery" },
        ],
        repeat: 8,
      },
    ];
    expect(sameSession(walkRun(rounds(8)), walkRun(reordered))).toBe(true);
    expect(sameSession(walkRun(rounds(8)), walkRun(rounds(7)))).toBe(false);
    expect(sameSession(walkRun(rounds(8)), walkRun(rounds(8, 300)))).toBe(false);
    expect(
      sameSession(
        walkRun(rounds(8)),
        walkRun([{ repeat: 8, steps: [byTime("run", "easy", 240)] }]),
      ),
    ).toBe(false);
    expect(sameSession(walkRun(rounds(8)), walkRun([byTime("run", "easy", 2400)]))).toBe(false);
  });

  it("always gives steps the contract accepts, for any factor the validator lets through", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SessionSteps>(
          TEMPO,
          easyRun(8000),
          easyRun(3000),
          easyRun(30_000),
          FINISH,
          STRIDES,
        ),
        fc.double({ min: 0.5, max: 1.1, noNaN: true }),
        fc.constantFrom("scale" as const, "easy" as const, "rest" as const),
        (steps, factor, kind) => {
          const delta = kind === "scale" ? { kind, factor } : { kind };
          const result = applyDelta(session("tempo", steps), delta, PACES);
          expect(sessionStepsSchema.parse(result.steps)).toEqual(result.steps);
          expect(result.target).toEqual(sessionTarget(result.steps, PACES));
          expect(result.target.distanceM).toBeLessThanOrEqual(
            Math.ceil(sessionTarget(steps, PACES).distanceM * Math.max(1, factor)),
          );
        },
      ),
    );
  });
});
