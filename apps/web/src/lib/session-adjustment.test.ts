import { describe, expect, it } from "vitest";
import { planSessionFixture } from "@/test/fixtures";
import {
  coachEasySessionFixture,
  coachRestSessionFixture,
  easedSessionFixture,
  pauseSkippedSessionFixture,
  planChangeFixture,
  walkRunSessionFixture,
} from "@/test/fixtures-adaptation";
import {
  reviewChangeFixture,
  reviewEasySessionFixture,
  reviewRestSessionFixture,
  reviewScaledSessionFixture,
} from "@/test/fixtures-weekly-review";
import { adjustmentLine, isRestChange, planChangeLine, snapshotAmount } from "./session-adjustment";

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

  it("says a session left in the pause was skipped during it, not eased (pause rest)", () => {
    expect(adjustmentLine(pauseSkippedSessionFixture(), "km")).toBe("Skipped during your pause");
  });

  it("names the walk-run and what it was, type included, though its distance is unchanged (walk-run easy)", () => {
    // 6 rounds of 5 min fill the planned 30:00, so the distance stays 5.0 km.
    expect(walkRunSessionFixture("2026-10-09").target.distanceM).toBe(4970);
    expect(adjustmentLine(walkRunSessionFixture("2026-10-09"), "km")).toBe(
      "Walk-run for your return, was Easy 5.0 km",
    );
  });

  it("names the walk-run and the long run it replaced (walk-run long run)", () => {
    expect(adjustmentLine(walkRunSessionFixture("2026-10-11"), "km")).toBe(
      "Walk-run for your return, was Long run 14.0 km",
    );
  });

  it("names the walk-run and the quality session it replaced (walk-run tempo)", () => {
    expect(adjustmentLine(walkRunSessionFixture("2026-10-15"), "km")).toBe(
      "Walk-run for your return, was Tempo 8.2 km",
    );
  });

  it("gives what a walk-run was in mi when the runner uses miles (walk-run unit conversion)", () => {
    expect(adjustmentLine(walkRunSessionFixture("2026-10-09"), "mi")).toBe(
      "Walk-run for your return, was Easy 3.1 mi",
    );
  });

  it("says the weekly review changed a session it cut, naming only the distance (review scale)", () => {
    expect(adjustmentLine(reviewScaledSessionFixture(), "km")).toBe(
      "Changed in your weekly review, was 18.0 km",
    );
  });

  it("names the original type when the weekly review made a quality session easy (review easy)", () => {
    expect(adjustmentLine(reviewEasySessionFixture(), "km")).toBe(
      "Changed in your weekly review, was Tempo 8.2 km",
    );
  });

  it("says the weekly review skipped a session it turned into a rest (review rest)", () => {
    expect(adjustmentLine(reviewRestSessionFixture(), "km")).toBe("Skipped in your weekly review");
  });

  it("gives what a session the review changed was in mi when the runner uses miles (review unit conversion)", () => {
    expect(adjustmentLine(reviewScaledSessionFixture(), "mi")).toBe(
      "Changed in your weekly review, was 11.2 mi",
    );
  });

  it("never calls a review's change a walk-run, even with that title (review is not a return)", () => {
    const titled = { ...reviewScaledSessionFixture(), title: "Walk-run" };
    expect(adjustmentLine(titled, "km")).toBe("Changed in your weekly review, was 18.0 km");
  });

  it("names the original type of a session the return eased into another type (re-entry type change)", () => {
    const planned = planSessionFixture("2026-10-15");
    const eased = planSessionFixture("2026-10-15", {
      type: "easy",
      target: { distanceM: 6900, durationS: 2400, zone: "easy" },
      steps: [{ kind: "run", zone: "easy", distanceM: null, durationS: 2400 }],
      adjustment: {
        source: "gap",
        kind: "re_entry",
        activityId: null,
        original: { type: planned.type, title: null, status: "planned", target: planned.target },
        at: "2026-10-07T17:00:00Z",
      },
    });
    expect(adjustmentLine(eased, "km")).toBe("Eased for your return, was Tempo 8.2 km");
  });
});

describe("isRestChange", () => {
  it("is true for a session the coach or a pause turned into a rest (coach rest, pause rest)", () => {
    expect(isRestChange(coachRestSessionFixture())).toBe(true);
    expect(isRestChange(pauseSkippedSessionFixture())).toBe(true);
    expect(isRestChange(coachEasySessionFixture())).toBe(false);
    expect(isRestChange(easedSessionFixture())).toBe(false);
    expect(isRestChange(walkRunSessionFixture())).toBe(false);
    expect(isRestChange(planSessionFixture("2026-10-09", { status: "skipped" }))).toBe(false);
  });

  it("is true for a session the weekly review turned into a rest, and false for one it cut (review rest)", () => {
    expect(isRestChange(reviewRestSessionFixture())).toBe(true);
    expect(isRestChange(reviewScaledSessionFixture())).toBe(false);
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

  it("reads a weekly review's change the same way, in km and mi (review change, unit conversion)", () => {
    expect(planChangeLine(reviewChangeFixture(), "km")).toBe(
      "Sun 18 Long run 18.0 km → Long run 16.2 km",
    );
    expect(planChangeLine(reviewChangeFixture(), "mi")).toBe(
      "Sun 18 Long run 11.2 mi → Long run 10.1 mi",
    );
  });
});
