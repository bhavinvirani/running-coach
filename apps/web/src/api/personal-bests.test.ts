import { describe, expect, it } from "vitest";
import { personalBestFixture, personalBestsFixture } from "@/test/fixtures";
import {
  PERSONAL_BESTS_POLL_MS,
  bestDistancesByRun,
  personalBestsPollInterval,
} from "./personal-bests";

const sunday = "0d6c8a4e-7b1f-4c2d-9e3a-5f6b7c8d9e0f";
const race = "8b9c0d1e-2f30-4a41-b526-c7d8e9f0a1b2";

describe("personalBestsPollInterval", () => {
  it("polls every 15 s while runs wait for their best efforts", () => {
    expect(PERSONAL_BESTS_POLL_MS).toBe(15_000);
    expect(personalBestsPollInterval(personalBestsFixture({ pendingRuns: 340 }))).toBe(15_000);
    expect(personalBestsPollInterval(personalBestsFixture({ pendingRuns: 1 }))).toBe(15_000);
  });

  it("stops polling once no run waits, and before the first answer", () => {
    expect(personalBestsPollInterval(personalBestsFixture({ pendingRuns: 0 }))).toBe(false);
    expect(personalBestsPollInterval(undefined)).toBe(false);
  });
});

describe("bestDistancesByRun", () => {
  it("lists the distances each run holds, shortest first however the bests arrive", () => {
    const byRun = bestDistancesByRun([
      personalBestFixture({ distanceKey: "half", activityId: race }),
      personalBestFixture({ distanceKey: "10k", activityId: sunday }),
      personalBestFixture({ distanceKey: "10mi", activityId: race }),
      personalBestFixture({ distanceKey: "5k", activityId: sunday }),
    ]);

    expect(byRun.get(sunday)).toEqual(["5k", "10k"]);
    expect(byRun.get(race)).toEqual(["10mi", "half"]);
    expect(byRun.size).toBe(2);
  });

  it("holds no run before any best is found", () => {
    expect(bestDistancesByRun([]).size).toBe(0);
  });
});
