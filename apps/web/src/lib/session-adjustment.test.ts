import { describe, expect, it } from "vitest";
import {
  coachEasySessionFixture,
  coachRestSessionFixture,
  easedSessionFixture,
  planChangeFixture,
  planSessionFixture,
} from "@/test/fixtures";
import { adjustmentLine, isCoachRest, planChangeLine, snapshotAmount } from "./session-adjustment";

describe("adjustmentLine", () => {
  it("says nothing for a session as planned", () => {
    expect(adjustmentLine(planSessionFixture("2026-10-11"), "km")).toBeNull();
  });

  it("says a session eased after a pause was its planned distance (pause re-entry)", () => {
    expect(adjustmentLine(easedSessionFixture("pause"), "km")).toBe(
      "Eased for your return, was 14.0 km",
    );
  });

  it("says the same for the return after 7 days without a run and no pause (gap re-entry)", () => {
    expect(adjustmentLine(easedSessionFixture("gap"), "km")).toBe(
      "Eased for your return, was 14.0 km",
    );
  });

  it("names the original type when the coach changed it (coach easy)", () => {
    expect(adjustmentLine(coachEasySessionFixture(), "km")).toBe(
      "Changed by the coach, was Intervals 11.6 km",
    );
  });

  it("names only the distance when the coach kept the type (coach scale)", () => {
    // The easy run on Fri 9 Oct cut to 80%: 5.0 km to 4.0 km.
    const planned = planSessionFixture("2026-10-09");
    const scaled = planSessionFixture("2026-10-09", {
      target: { ...planned.target, distanceM: 3980, durationS: 1440 },
      adjustment: {
        source: "coach",
        kind: "scale",
        activityId: null,
        original: { type: planned.type, title: null, status: "planned", target: planned.target },
        at: "2026-10-07T17:00:00Z",
      },
    });
    expect(adjustmentLine(scaled, "km")).toBe("Changed by the coach, was 5.0 km");
  });

  it("says the coach skipped a session it turned into a rest (coach rest)", () => {
    expect(adjustmentLine(coachRestSessionFixture(), "km")).toBe("Skipped by the coach");
  });

  it("gives the planned distance in mi when the runner uses miles (unit conversion)", () => {
    expect(adjustmentLine(easedSessionFixture(), "mi")).toBe("Eased for your return, was 8.7 mi");
  });
});

describe("isCoachRest", () => {
  it("is true only for a session the coach turned into a rest (coach rest)", () => {
    expect(isCoachRest(coachRestSessionFixture())).toBe(true);
    expect(isCoachRest(coachEasySessionFixture())).toBe(false);
    expect(isCoachRest(easedSessionFixture())).toBe(false);
    expect(isCoachRest(planSessionFixture("2026-10-09", { status: "skipped" }))).toBe(false);
  });
});

describe("snapshotAmount", () => {
  it("is the distance, else the time of a session without one (strength), else nothing", () => {
    expect(snapshotAmount({ distanceM: 8180, durationS: 2716, zone: "threshold" }, "km")).toBe(
      "8.2 km",
    );
    expect(snapshotAmount({ distanceM: 0, durationS: 1800, zone: null }, "km")).toBe("30:00");
    expect(snapshotAmount({ distanceM: 0, durationS: 0, zone: null }, "km")).toBeNull();
  });
});

describe("planChangeLine", () => {
  it("reads the session before and after the coach's change", () => {
    expect(planChangeLine(planChangeFixture(), "km")).toBe(
      "Thu 8 Intervals 11.6 km → Easy 10.6 km",
    );
  });

  it("reads a rest as the session skipped (coach rest)", () => {
    const rest = coachRestSessionFixture();
    const planned = planSessionFixture("2026-10-09");
    const change = planChangeFixture({
      sessionId: rest.id,
      date: rest.date,
      kind: "rest",
      before: { type: planned.type, title: null, status: "planned", target: planned.target },
      after: { type: rest.type, title: null, status: "skipped", target: rest.target },
    });
    expect(planChangeLine(change, "km")).toBe("Fri 9 Easy 5.0 km skipped");
  });

  it("names the after side Rest without a distance when the session became a rest day", () => {
    const change = planChangeFixture({
      after: {
        type: "rest",
        title: null,
        status: "skipped",
        target: { distanceM: 0, durationS: 0, zone: null },
      },
    });
    expect(planChangeLine(change, "km")).toBe("Thu 8 Intervals 11.6 km → Rest");
  });

  it("converts both sides to mi when the runner uses miles (unit conversion)", () => {
    expect(planChangeLine(planChangeFixture(), "mi")).toBe("Thu 8 Intervals 7.2 mi → Easy 6.6 mi");
  });
});
