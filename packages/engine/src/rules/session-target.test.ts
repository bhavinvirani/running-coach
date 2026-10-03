import type { PlanPaces, SessionSteps, Step } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bandMidpointSPerKm, distanceForDurationM, sessionTarget } from "./session-target";

const PACES: PlanPaces = {
  easy: { fastSPerKm: 300, slowSPerKm: 340 }, // midpoint 320 s/km
  marathon: { fastSPerKm: 265, slowSPerKm: 276 },
  threshold: { fastSPerKm: 251, slowSPerKm: 259 }, // midpoint 255 s/km
  interval: { fastSPerKm: 230, slowSPerKm: 238 },
  repetition: { fastSPerKm: 216, slowSPerKm: 223 },
  race: { fastSPerKm: 236, slowSPerKm: 244 }, // midpoint 240 s/km
};

const byTime = (kind: Step["kind"], zone: Step["zone"], durationS: number): Step => ({
  kind,
  zone,
  distanceM: null,
  durationS,
});
const byDistance = (kind: Step["kind"], zone: Step["zone"], distanceM: number): Step => ({
  kind,
  zone,
  distanceM,
  durationS: null,
});

describe("session target", () => {
  it("takes a band's midpoint pace", () => {
    expect(bandMidpointSPerKm(PACES.easy)).toBe(320);
    expect(bandMidpointSPerKm(PACES.repetition)).toBe(219.5);
  });

  it("converts a duration to whole meters at a pace, rounding down", () => {
    expect(distanceForDurationM(1200, 320)).toBe(3750);
    expect(distanceForDurationM(1201, 320)).toBe(3753);
  });

  it("sums an easy run by distance into distance and time at the easy midpoint, zone easy", () => {
    expect(sessionTarget([byDistance("run", "easy", 8000)], PACES)).toEqual({
      distanceM: 8000,
      durationS: 2560,
      zone: "easy",
    });
  });

  it("names the race zone for a race run by distance", () => {
    expect(sessionTarget([byDistance("run", "race", 5000)], PACES)).toEqual({
      distanceM: 5000,
      durationS: 1200,
      zone: "race",
    });
  });

  it("converts time steps through their zone, multiplies repeats and names the work zone", () => {
    const steps: SessionSteps = [
      byTime("warmup", "easy", 900), // 2813 m
      {
        repeat: 2,
        steps: [byDistance("work", "threshold", 3000), byTime("recovery", "easy", 60)], // 765 s, 188 m
      },
      byTime("cooldown", "easy", 600), // 1875 m
    ];
    expect(sessionTarget(steps, PACES)).toEqual({
      distanceM: 2813 + 2 * (3000 + 188) + 1875,
      durationS: 900 + 2 * (765 + 60) + 600,
      zone: "threshold",
    });
  });

  it("names easy for a session with no work and no run step", () => {
    expect(sessionTarget([byTime("warmup", "easy", 600)], PACES).zone).toBe("easy");
  });

  it("gives whole meters and seconds that grow with every step added", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.integer({ min: 10, max: 20_000 }).map((m) => byDistance("run", "easy", m)),
            fc.integer({ min: 1, max: 3600 }).map((s) => byTime("work", "interval", s)),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        (steps) => {
          const target = sessionTarget(steps, PACES);
          const shorter = sessionTarget(steps.slice(0, -1), PACES);
          expect(Number.isInteger(target.distanceM) && Number.isInteger(target.durationS)).toBe(
            true,
          );
          expect(target.distanceM).toBeGreaterThan(shorter.distanceM);
          expect(target.durationS).toBeGreaterThan(shorter.durationS);
        },
      ),
    );
  });
});
