import { describe, expect, it } from "vitest";
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
  it("says nothing for a planned session and names every other status", () => {
    expect(statusWord("planned")).toBeNull();
    expect(statusWord("moved")).toBe("Moved");
    expect(statusWord("skipped")).toBe("Skipped");
    expect(statusWord("missed")).toBe("Missed");
    expect(statusWord("done")).toBe("Done");
  });
});

describe("repeatLabel", () => {
  it("reads a repeat count as its group heading", () => {
    expect(repeatLabel(5)).toBe("5 x");
  });
});
