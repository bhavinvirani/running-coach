import type { PlanPaces } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import {
  OPEN_STEP_TARGET,
  isPacedStep,
  paceZoneName,
  readsInUnits,
  sessionName,
  stepAmount,
  stepKindName,
  stepTarget,
} from "./workout-steps";

const paces: PlanPaces = {
  easy: { fastSPerKm: 345, slowSPerKm: 380 },
  marathon: { fastSPerKm: 315, slowSPerKm: 322 },
  threshold: { fastSPerKm: 300, slowSPerKm: 307 },
  interval: { fastSPerKm: 285, slowSPerKm: 292 },
  repetition: { fastSPerKm: 270, slowSPerKm: 275 },
  race: { fastSPerKm: 294, slowSPerKm: 298 },
};

describe("stepKindName", () => {
  it("names each kind as the builder and the watch do", () => {
    expect(stepKindName("warmup")).toBe("Warm-up");
    expect(stepKindName("run")).toBe("Run");
    expect(stepKindName("work")).toBe("Work");
    expect(stepKindName("recovery")).toBe("Recovery");
    expect(stepKindName("cooldown")).toBe("Cool-down");
  });
});

describe("paceZoneName", () => {
  it("names each zone in words", () => {
    expect(paceZoneName("easy")).toBe("Easy");
    expect(paceZoneName("threshold")).toBe("Threshold");
    expect(paceZoneName("repetition")).toBe("Repetition");
  });
});

describe("stepTarget", () => {
  it("gives run and work steps their zone's band in the runner's unit", () => {
    expect(isPacedStep("run")).toBe(true);
    expect(stepTarget({ kind: "work", zone: "interval" }, paces, "km")).toBe(
      "4:45-4:52 /km interval pace",
    );
    expect(stepTarget({ kind: "run", zone: "easy" }, paces, "mi")).toBe("9:15-10:12 /mi easy");
  });

  it("leaves warm-up, recovery and cool-down open, whatever their zone", () => {
    for (const kind of ["warmup", "recovery", "cooldown"] as const) {
      expect(isPacedStep(kind)).toBe(false);
      expect(stepTarget({ kind, zone: "threshold" }, paces, "km")).toBe(OPEN_STEP_TARGET);
    }
    expect(OPEN_STEP_TARGET).toBe("Easy, no pace alert");
  });
});

describe("stepAmount", () => {
  it("reads a time in words and a distance in the runner's unit, a short rep in meters (unit conversion)", () => {
    expect(stepAmount({ distanceM: null, durationS: 900 }, "km")).toBe("15 min");
    expect(stepAmount({ distanceM: 5000, durationS: null }, "km")).toBe("5 km");
    expect(stepAmount({ distanceM: 4828, durationS: null }, "mi")).toBe("3 mi");
    expect(stepAmount({ distanceM: 1000, durationS: null }, "mi")).toBe("1000 m");
    expect(stepAmount({ distanceM: 400, durationS: null }, "km")).toBe("400 m");
  });

  it("reads a 1 mi step saved as 1609 m as 1 mi, not 1609 m (1609 m in mi)", () => {
    expect(stepAmount({ distanceM: 1609, durationS: null }, "mi")).toBe("1 mi");
    expect(stepAmount({ distanceM: 1608, durationS: null }, "mi")).toBe("1608 m");
    expect(stepAmount({ distanceM: 999, durationS: null }, "km")).toBe("999 m");
  });
});

describe("readsInUnits", () => {
  it("counts from one unit, less the half meter saving whole meters takes off (1609 m in mi)", () => {
    expect(readsInUnits(1609, "mi")).toBe(true);
    expect(readsInUnits(1608, "mi")).toBe(false);
    expect(readsInUnits(1000, "km")).toBe(true);
    expect(readsInUnits(999, "km")).toBe(false);
  });
});

describe("sessionName", () => {
  it("uses a custom workout's title, else the type's name", () => {
    expect(sessionName({ title: "Hill reps", type: "tempo" })).toBe("Hill reps");
    expect(sessionName({ title: null, type: "long" })).toBe("Long run");
  });
});
