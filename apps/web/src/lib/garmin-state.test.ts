import type { GarminPushStatus, PlanSession } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { garminCaption } from "./garmin-state";

const TODAY = "2026-10-08";

const run: Pick<PlanSession, "status" | "onGarmin" | "steps" | "date"> = {
  status: "planned",
  onGarmin: false,
  steps: [{ kind: "run", zone: "easy", distanceM: null, durationS: 2700 }],
  date: TODAY,
};

const ok: Pick<GarminPushStatus, "connection" | "pushing" | "error"> = {
  connection: "ok",
  pushing: false,
  error: null,
};

describe("garminCaption", () => {
  it("says Skipped for a skipped session, before anything else", () => {
    expect(garminCaption({ ...run, status: "skipped", onGarmin: true }, ok, TODAY)).toBe("Skipped");
  });

  it("says On Garmin once Garmin holds the session as it is", () => {
    expect(garminCaption({ ...run, onGarmin: true }, { ...ok, connection: "expired" }, TODAY)).toBe(
      "On Garmin",
    );
  });

  it("says nothing for a session without steps (strength) or a past one (missed or moved session)", () => {
    expect(garminCaption({ ...run, steps: [] }, ok, TODAY)).toBeNull();
    expect(garminCaption({ ...run, date: "2026-10-07" }, ok, TODAY)).toBeNull();
  });

  it("says a session past the 7-day window goes a week ahead, today and six days on are in it", () => {
    expect(garminCaption({ ...run, date: "2026-10-14" }, ok, TODAY)).toBe("Waiting to send");
    expect(garminCaption({ ...run, date: "2026-10-15" }, ok, TODAY)).toBe("Sent a week ahead");
  });

  it("says Not on Garmin while the login is expired or Garmin is not connected (token expiry)", () => {
    expect(garminCaption(run, { ...ok, connection: "expired", pushing: true }, TODAY)).toBe(
      "Not on Garmin",
    );
    expect(garminCaption(run, { ...ok, connection: "not_connected" }, TODAY)).toBe("Not on Garmin");
  });

  it("says Sending while a push runs, even after a failed one", () => {
    expect(garminCaption(run, { ...ok, pushing: true, error: "garmin_unavailable" }, TODAY)).toBe(
      "Sending",
    );
  });

  it("says Not sent when the last push stopped short (Garmin outage or 429)", () => {
    expect(garminCaption(run, { ...ok, error: "garmin_rate_limited" }, TODAY)).toBe("Not sent");
  });

  it("says Waiting to send for a session the next push will send", () => {
    expect(garminCaption({ ...run, status: "moved" }, ok, TODAY)).toBe("Waiting to send");
  });

  it("counts the window from the runner's local date across a month (time zones)", () => {
    expect(garminCaption({ ...run, date: "2026-11-05" }, ok, "2026-10-30")).toBe("Waiting to send");
    expect(garminCaption({ ...run, date: "2026-11-06" }, ok, "2026-10-30")).toBe(
      "Sent a week ahead",
    );
  });
});
