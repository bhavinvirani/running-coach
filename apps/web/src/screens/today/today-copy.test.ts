import { describe, expect, it } from "vitest";
import { syncOutcomeLine, todayCopy } from "./today-copy";

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
