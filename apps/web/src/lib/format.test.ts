import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MISSING,
  formatDateTime,
  formatDistance,
  formatDistanceValue,
  formatDuration,
  formatHeartRate,
  formatLocalDateTime,
  formatPace,
  formatPaceValue,
} from "./format";

describe("formatPace", () => {
  it("formats seconds per unit as m:ss with the unit", () => {
    expect(formatPace(305, "km")).toBe("5:05 /km");
    expect(formatPace(491, "mi")).toBe("8:11 /mi");
    expect(formatPace(59, "km")).toBe("0:59 /km");
  });

  it("rounds before splitting so 299.6 s reads 5:00, not 4:60", () => {
    expect(formatPaceValue(299.6)).toBe("5:00");
    expect(formatPaceValue(299.4)).toBe("4:59");
  });

  it("shows the missing mark for null, zero, negative and non-finite paces", () => {
    expect(formatPace(null, "km")).toBe(MISSING);
    expect(formatPace(undefined, "mi")).toBe(MISSING);
    expect(formatPace(0, "km")).toBe(MISSING);
    expect(formatPace(-10, "km")).toBe(MISSING);
    expect(formatPace(Number.POSITIVE_INFINITY, "km")).toBe(MISSING);
  });
});

describe("formatDuration", () => {
  it("uses mm:ss under an hour", () => {
    expect(formatDuration(330)).toBe("05:30");
    expect(formatDuration(3138)).toBe("52:18");
    expect(formatDuration(0)).toBe("00:00");
  });

  it("uses h:mm:ss from an hour up", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(4325)).toBe("1:12:05");
    expect(formatDuration(36_000)).toBe("10:00:00");
  });

  it("rounds fractional seconds", () => {
    expect(formatDuration(59.5)).toBe("01:00");
  });

  it("shows the missing mark for null and negative durations", () => {
    expect(formatDuration(null)).toBe(MISSING);
    expect(formatDuration(-1)).toBe(MISSING);
    expect(formatDuration(Number.NaN)).toBe(MISSING);
  });
});

describe("formatDistance", () => {
  it("shows one decimal and the unit", () => {
    expect(formatDistance(10.04, "km")).toBe("10.0 km");
    expect(formatDistance(6.25, "mi")).toBe("6.3 mi");
    expect(formatDistance(0, "km")).toBe("0.0 km");
  });

  it("shows the missing mark for null and negative distances", () => {
    expect(formatDistance(null, "km")).toBe(MISSING);
    expect(formatDistance(-0.5, "km")).toBe(MISSING);
  });
});

describe("formatDistanceValue", () => {
  it("shows one decimal without the unit, for a figure whose unit is drawn smaller", () => {
    expect(formatDistanceValue(10.04)).toBe("10.0");
    expect(formatDistanceValue(6.25)).toBe("6.3");
    expect(formatDistanceValue(null)).toBe(MISSING);
    expect(formatDistanceValue(-1)).toBe(MISSING);
  });
});

describe("formatHeartRate", () => {
  it("rounds to whole beats per minute", () => {
    expect(formatHeartRate(148)).toBe("148");
    expect(formatHeartRate(147.6)).toBe("148");
  });

  it("shows the missing mark when the run has no HR", () => {
    expect(formatHeartRate(null)).toBe(MISSING);
    expect(formatHeartRate(undefined)).toBe(MISSING);
    expect(formatHeartRate(0)).toBe(MISSING);
  });
});

describe("formatLocalDateTime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the run's own wall-clock start", () => {
    expect(formatLocalDateTime("2026-09-27T07:12:00")).toBe("Sun 27 Sep, 07:12");
    expect(formatLocalDateTime("2026-01-01T00:05:59.500")).toBe("Thu 1 Jan, 00:05");
  });

  it("keeps a DST-day local time as wall-clock whatever the device's zone", () => {
    // 01:30 on 29 Mar 2026 does not exist in London (clocks jump 01:00 to 02:00), and 01:30 on 25 Oct
    // happens twice. A run recorded there at those times still reads as the runner's watch showed it.
    vi.stubEnv("TZ", "Europe/London");
    expect(new Date(2026, 2, 29, 1, 30).getHours()).toBe(2);
    expect(formatLocalDateTime("2026-03-29T01:30:00")).toBe("Sun 29 Mar, 01:30");
    expect(formatLocalDateTime("2026-10-25T01:30:00")).toBe("Sun 25 Oct, 01:30");

    vi.stubEnv("TZ", "Pacific/Auckland");
    expect(formatLocalDateTime("2026-03-29T01:30:00")).toBe("Sun 29 Mar, 01:30");
  });

  it("shows the missing mark for null and malformed values", () => {
    expect(formatLocalDateTime(null)).toBe(MISSING);
    expect(formatLocalDateTime("27/09/2026 07:12")).toBe(MISSING);
    expect(formatLocalDateTime("2026-02-30T07:12:00")).toBe(MISSING);
  });
});

describe("formatDateTime", () => {
  it("shows a UTC instant in the given time zone", () => {
    expect(formatDateTime("2026-09-27T06:12:00Z", "UTC")).toBe("Sun 27 Sep 2026, 06:12");
    expect(formatDateTime("2026-09-27T06:12:00Z", "Asia/Kolkata")).toBe("Sun 27 Sep 2026, 11:42");
  });

  it("crosses the date line when the zone does", () => {
    expect(formatDateTime("2026-09-27T23:30:00Z", "Pacific/Auckland")).toBe(
      "Mon 28 Sep 2026, 12:30",
    );
  });

  it("follows daylight saving time", () => {
    expect(formatDateTime("2026-07-01T12:00:00Z", "Europe/London")).toBe("Wed 1 Jul 2026, 13:00");
    expect(formatDateTime("2026-12-01T12:00:00Z", "Europe/London")).toBe("Tue 1 Dec 2026, 12:00");
  });

  it("shows the missing mark for null and invalid instants", () => {
    expect(formatDateTime(null, "UTC")).toBe(MISSING);
    expect(formatDateTime("not a date", "UTC")).toBe(MISSING);
  });
});
