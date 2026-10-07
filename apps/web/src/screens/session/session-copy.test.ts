import type { SessionStatus } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { coachRestSessionFixture, pauseSkippedSessionFixture } from "@/test/fixtures";
import { moveWarningSentence, repeatLabel, statusWord } from "./session-copy";

describe("moveWarningSentence", () => {
  it("names the hard session a day away and the 48 hours the plan keeps", () => {
    expect(
      moveWarningSentence("Tempo", "2026-10-09", {
        code: "hard_days_close",
        otherType: "intervals",
        otherDate: "2026-10-08",
      }),
    ).toBe(
      "Tempo is now a day from Intervals on Thu 8. The plan keeps 48 hours between hard sessions.",
    );
  });

  it("says when both hard sessions now share a day", () => {
    expect(
      moveWarningSentence("Hill reps", "2026-10-08", {
        code: "hard_days_close",
        otherType: "intervals",
        otherDate: "2026-10-08",
      }),
    ).toBe(
      "Hill reps is now on the same day as Intervals. The plan keeps 48 hours between hard sessions.",
    );
  });
});

describe("statusWord", () => {
  const as = (status: SessionStatus, paused = false) => ({ status, paused, adjustment: null });

  it("says nothing for a planned session and names every other status", () => {
    expect(statusWord(as("planned"))).toBeNull();
    expect(statusWord(as("moved"))).toBe("Moved");
    expect(statusWord(as("skipped"))).toBe("Skipped");
    expect(statusWord(as("missed"))).toBe("Missed");
    expect(statusWord(as("done"))).toBe("Done");
  });

  it("says Paused for a session to come in an open pause, planned or moved (paused session)", () => {
    expect(statusWord(as("planned", true))).toBe("Paused");
    expect(statusWord(as("moved", true))).toBe("Paused");
    expect(statusWord(as("skipped", true))).toBe("Skipped");
  });

  it("leaves a coach rest to its adjustment line (coach rest)", () => {
    expect(statusWord(coachRestSessionFixture())).toBeNull();
  });

  it("leaves a session the pause skipped to its adjustment line (pause rest)", () => {
    expect(statusWord(pauseSkippedSessionFixture())).toBeNull();
  });
});

describe("repeatLabel", () => {
  it("reads a repeat count as its group heading", () => {
    expect(repeatLabel(5)).toBe("5 x");
  });
});
