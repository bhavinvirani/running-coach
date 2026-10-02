import type { PlanPaces, SessionSteps } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { describeSteps } from "./describe-steps";

const paces: PlanPaces = {
  easy: { fastSPerKm: 345, slowSPerKm: 380 },
  marathon: { fastSPerKm: 315, slowSPerKm: 322 },
  threshold: { fastSPerKm: 300, slowSPerKm: 307 },
  interval: { fastSPerKm: 285, slowSPerKm: 292 },
  repetition: { fastSPerKm: 270, slowSPerKm: 275 },
  race: { fastSPerKm: 296, slowSPerKm: 296 },
};

const intervals: SessionSteps = [
  { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
  {
    repeat: 5,
    steps: [
      { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
      { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
    ],
  },
  { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
];

describe("describeSteps", () => {
  it("reads a warm-up, repeats with a jog between them and a cool-down as one line", () => {
    expect(describeSteps(intervals, paces, "km")).toBe(
      "15 min easy, 5 x 1 km at 4:45-4:52 /km with 3 min jog, 10 min easy",
    );
  });

  it("converts the band to minutes per mile and a short rep to meters (mi units)", () => {
    // 285 and 292 s/km are 458.7 and 469.9 s/mi; 1 km is under a mile, so it stays in meters.
    expect(describeSteps(intervals, paces, "mi")).toBe(
      "15 min easy, 5 x 1000 m at 7:39-7:50 /mi with 3 min jog, 10 min easy",
    );
  });

  it("reads a long run by distance as easy, with no pace", () => {
    const long: SessionSteps = [{ kind: "run", zone: "easy", distanceM: 16000, durationS: null }];
    expect(describeSteps(long, paces, "km")).toBe("16 km easy");
    expect(describeSteps(long, paces, "mi")).toBe("9.9 mi easy");
  });

  it("reads a tempo block at the threshold band", () => {
    const tempo: SessionSteps = [
      { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
      { kind: "work", zone: "threshold", distanceM: 4000, durationS: null },
      { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
    ];
    expect(describeSteps(tempo, paces, "km")).toBe(
      "15 min easy, 4 km at 5:00-5:07 /km, 10 min easy",
    );
  });

  it("shows one pace for a band whose ends are equal (race)", () => {
    const race: SessionSteps = [{ kind: "run", zone: "race", distanceM: 10000, durationS: null }];
    expect(describeSteps(race, paces, "km")).toBe("10 km at 4:56 /km");
  });

  it("reads a rep by time, with a recovery by distance", () => {
    const strides: SessionSteps = [
      {
        repeat: 6,
        steps: [
          { kind: "work", zone: "repetition", distanceM: null, durationS: 20 },
          { kind: "recovery", zone: "easy", distanceM: 200, durationS: null },
        ],
      },
    ];
    expect(describeSteps(strides, paces, "km")).toBe("6 x 20 s at 4:30-4:35 /km with 200 m jog");
  });

  it("groups a repeat of several hard steps in brackets", () => {
    const mixed: SessionSteps = [
      {
        repeat: 3,
        steps: [
          { kind: "work", zone: "threshold", distanceM: 1000, durationS: null },
          { kind: "work", zone: "interval", distanceM: 400, durationS: null },
          { kind: "recovery", zone: "easy", distanceM: null, durationS: 120 },
        ],
      },
    ];
    expect(describeSteps(mixed, paces, "km")).toBe(
      "3 x (1 km at 5:00-5:07 /km, 400 m at 4:45-4:52 /km) with 2 min jog",
    );
  });

  it("reads a marathon-pace finish after easy kilometers", () => {
    const finish: SessionSteps = [
      { kind: "run", zone: "easy", distanceM: 14000, durationS: null },
      { kind: "run", zone: "marathon", distanceM: 4000, durationS: null },
    ];
    expect(describeSteps(finish, paces, "km")).toBe("14 km easy, 4 km at 5:15-5:22 /km");
  });

  it("is empty for a session with no steps", () => {
    expect(describeSteps([], paces, "km")).toBe("");
  });
});
