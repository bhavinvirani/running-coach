import { describe, expect, it } from "vitest";
import {
  PAUSE_ADVICE,
  isHealthReason,
  reEntryLine,
  syncOutcomeLine,
  todayCopy,
} from "./today-copy";

const at = "2026-09-28T07:40:00Z";

describe("syncOutcomeLine", () => {
  it("says there are no new runs only when the sync wrote and removed nothing (nothing new)", () => {
    expect(syncOutcomeLine({ lastSyncAt: at, activitiesWritten: 0, activitiesRemoved: 0 })).toBe(
      todayCopy.noNewRuns,
    );
    expect(todayCopy.noNewRuns).toBe("No new runs on Garmin.");
  });

  it("says nothing when the sync brought runs in, which show for themselves", () => {
    expect(
      syncOutcomeLine({ lastSyncAt: at, activitiesWritten: 2, activitiesRemoved: 0 }),
    ).toBeNull();
  });

  it("counts the runs removed because Garmin no longer lists them, in words true for a run deleted there or changed to another sport (deleted activity, edited activity)", () => {
    expect(syncOutcomeLine({ lastSyncAt: at, activitiesWritten: 0, activitiesRemoved: 1 })).toBe(
      "Removed 1 run Garmin no longer lists.",
    );
    expect(syncOutcomeLine({ lastSyncAt: at, activitiesWritten: 0, activitiesRemoved: 3 })).toBe(
      "Removed 3 runs Garmin no longer lists.",
    );
  });

  it("says what was removed also when the same sync brought new runs in (deleted activity)", () => {
    expect(syncOutcomeLine({ lastSyncAt: at, activitiesWritten: 1, activitiesRemoved: 1 })).toBe(
      "Removed 1 run Garmin no longer lists.",
    );
  });
});

describe("reEntryLine", () => {
  const back = { fromDate: "2026-10-17", sessionsChanged: 6 };

  it("says the days off, the eased share and the 10% build, then 7 days of walk-run from the return after illness or injury (I'm back 0.7 walk-run)", () => {
    expect(reEntryLine({ ...back, daysOff: 9, factor: 0.7, walkRun: true })).toBe(
      "9 days off: the next sessions are eased to 70% and build back up by at most 10% a week. The next 7 days are walk-run.",
    );
  });

  it("leaves walk-run out after a break taken while well (I'm back 0.5)", () => {
    expect(reEntryLine({ ...back, daysOff: 14, factor: 0.5, walkRun: false })).toBe(
      "14 days off: the next sessions are eased to 50% and build back up by at most 10% a week.",
    );
  });

  it("says only the 7 days of walk-run from the return when a short illness left the volume as planned (I'm back 1 walk-run)", () => {
    expect(reEntryLine({ ...back, daysOff: 3, factor: 1, walkRun: true })).toBe(
      "The next 7 days are walk-run, then the plan carries on.",
    );
  });

  it("says the plan carries on after a short break (I'm back 1)", () => {
    expect(
      reEntryLine({ ...back, daysOff: 2, factor: 1, walkRun: false, sessionsChanged: 0 }),
    ).toBe("Your plan carries on as planned.");
  });
});

describe("pause advice", () => {
  it("points illness and injury to a doctor or physio and marks them not medical advice, a break neither", () => {
    expect(PAUSE_ADVICE.sick).toContain("See a doctor");
    expect(PAUSE_ADVICE.injured).toContain("doctor or physio");
    expect(isHealthReason("sick")).toBe(true);
    expect(isHealthReason("injured")).toBe(true);
    expect(isHealthReason("break")).toBe(false);
    expect(todayCopy.notMedicalAdvice).toBe("This is not medical advice.");
  });

  it("names the paused card by the local day the pause started (time zones)", () => {
    expect(todayCopy.pausedSince("2026-10-08")).toBe("Training paused since Thu 8 Oct");
  });
});
