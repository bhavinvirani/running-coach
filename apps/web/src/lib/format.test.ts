import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MISSING,
  elevationUnitLabel,
  formatCadence,
  formatCalories,
  formatCount,
  formatCountValue,
  formatDate,
  formatDateTime,
  formatDistance,
  formatDistanceValue,
  formatDuration,
  formatElevation,
  formatElevationValue,
  formatHeartRate,
  formatLapDistance,
  formatLapDistanceValue,
  formatLocalDateTime,
  formatLocalDate,
  formatLocalDay,
  formatLocalTime,
  formatMeters,
  formatMonthYear,
  formatPace,
  formatPaceBand,
  formatPaceDelta,
  formatPaceValue,
  formatPercent,
  formatRecordTime,
  formatStepDistance,
  formatStepDuration,
  formatTime,
  formatTwoDigits,
  formatWeekRange,
  recordSeconds,
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

describe("formatPaceDelta", () => {
  it("signs a faster lap + and a slower one -, as m:ss", () => {
    expect(formatPaceDelta(5)).toBe("+0:05");
    expect(formatPaceDelta(-27)).toBe("-0:27");
    expect(formatPaceDelta(75)).toBe("+1:15");
    expect(formatPaceDelta(-600)).toBe("-10:00");
  });

  it("shows an equal pace unsigned", () => {
    expect(formatPaceDelta(0)).toBe("0:00");
  });

  it("rounds to whole seconds first, so -0.4 s reads 0:00 and never -0:00", () => {
    expect(formatPaceDelta(-0.4)).toBe("0:00");
    expect(formatPaceDelta(0.4)).toBe("0:00");
    expect(formatPaceDelta(4.6)).toBe("+0:05");
    expect(formatPaceDelta(-59.6)).toBe("-1:00");
  });

  it("shows the missing mark for null and non-finite deltas", () => {
    expect(formatPaceDelta(null)).toBe(MISSING);
    expect(formatPaceDelta(undefined)).toBe(MISSING);
    expect(formatPaceDelta(Number.NaN)).toBe(MISSING);
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

describe("formatLapDistance", () => {
  it("shows one decimal from about one unit up, like any distance", () => {
    expect(formatLapDistance(1, "km")).toBe("1.0 km");
    expect(formatLapDistance(0.996, "mi")).toBe("1.0 mi");
    expect(formatLapDistance(2.04, "km")).toBe("2.0 km");
  });

  it("shows two decimals under one unit, so a short last lap never reads 0.0", () => {
    expect(formatLapDistance(0.04, "km")).toBe("0.04 km");
    expect(formatLapDistance(0.621, "mi")).toBe("0.62 mi");
    expect(formatLapDistance(0.949, "km")).toBe("0.95 km");
  });

  it("shows the missing mark for null and negative distances", () => {
    expect(formatLapDistance(null, "km")).toBe(MISSING);
    expect(formatLapDistance(-0.1, "km")).toBe(MISSING);
  });
});

describe("formatLapDistanceValue", () => {
  it("shows the lap distance without its unit, two decimals under one unit", () => {
    expect(formatLapDistanceValue(0.04)).toBe("0.04");
    expect(formatLapDistanceValue(0.621)).toBe("0.62");
    expect(formatLapDistanceValue(1)).toBe("1.0");
    expect(formatLapDistanceValue(2.04)).toBe("2.0");
  });

  it("shows the missing mark for null and negative distances", () => {
    expect(formatLapDistanceValue(null)).toBe(MISSING);
    expect(formatLapDistanceValue(-0.1)).toBe(MISSING);
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

describe("formatDate", () => {
  it("shows the day of a UTC instant in the given time zone", () => {
    expect(formatDate("2026-10-02T06:40:00Z", "Europe/London")).toBe("2 Oct 2026");
    // 23:30 UTC is already the next day in Auckland.
    expect(formatDate("2026-10-02T23:30:00Z", "Pacific/Auckland")).toBe("3 Oct 2026");
  });

  it("shows the missing mark for null and invalid instants", () => {
    expect(formatDate(null, "UTC")).toBe(MISSING);
    expect(formatDate("not a date", "UTC")).toBe(MISSING);
  });
});

describe("formatTime", () => {
  it("shows the wall-clock time of a UTC instant in the given time zone", () => {
    expect(formatTime("2026-10-02T13:05:00Z", "UTC")).toBe("13:05");
    expect(formatTime("2026-10-02T13:05:00Z", "Europe/London")).toBe("14:05");
    expect(formatTime("2026-10-02T13:05:00Z", "Asia/Kolkata")).toBe("18:35");
  });

  it("follows daylight saving time (DST)", () => {
    expect(formatTime("2026-10-25T00:30:00Z", "Europe/London")).toBe("01:30");
    expect(formatTime("2026-10-25T01:30:00Z", "Europe/London")).toBe("01:30");
    expect(formatTime("2026-10-25T02:30:00Z", "Europe/London")).toBe("02:30");
  });

  it("shows the missing mark for null and invalid instants", () => {
    expect(formatTime(undefined, "UTC")).toBe(MISSING);
    expect(formatTime("soon", "UTC")).toBe(MISSING);
  });
});

describe("formatLocalDay", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the weekday and date of the run's own wall-clock start", () => {
    expect(formatLocalDay("2026-09-27T07:12:00")).toBe("Sun 27 Sep");
    expect(formatLocalDay("2026-09-28T23:55:00")).toBe("Mon 28 Sep");
  });

  it("keeps a run late on Sunday night on Sunday whatever the device's zone (time zones)", () => {
    vi.stubEnv("TZ", "Pacific/Auckland");
    expect(formatLocalDay("2026-09-27T23:30:00")).toBe("Sun 27 Sep");
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(formatLocalDay("2026-03-29T01:30:00")).toBe("Sun 29 Mar");
  });

  it("shows the missing mark for null and malformed values", () => {
    expect(formatLocalDay(null)).toBe(MISSING);
    expect(formatLocalDay("27/09/2026")).toBe(MISSING);
    expect(formatLocalDay("2026-02-30T07:12:00")).toBe(MISSING);
  });
});

describe("formatMonthYear", () => {
  it("shows the month and year of a calendar date", () => {
    expect(formatMonthYear("2021-03-14")).toBe("Mar 2021");
    expect(formatMonthYear("2026-12-01")).toBe("Dec 2026");
  });

  it("shows the missing mark for null and malformed dates", () => {
    expect(formatMonthYear(null)).toBe(MISSING);
    expect(formatMonthYear("2021-13-01")).toBe(MISSING);
    expect(formatMonthYear("March 2021")).toBe(MISSING);
  });
});

describe("formatWeekRange", () => {
  it("shows a week within one month as one range", () => {
    expect(formatWeekRange("2026-09-21")).toBe("21–27 Sep");
    expect(formatWeekRange("2026-09-21", "2026-09-21")).toBe("21–27 Sep");
  });

  it("names both months when the week crosses into the next one", () => {
    expect(formatWeekRange("2026-09-28")).toBe("28 Sep – 4 Oct");
    expect(formatWeekRange("2026-09-29")).toBe("29 Sep – 5 Oct");
  });

  it("leaves out the year for weeks in the newest week's year", () => {
    expect(formatWeekRange("2026-01-05", "2026-09-21")).toBe("5–11 Jan");
    expect(formatWeekRange("2026-02-23", "2026-09-21")).toBe("23 Feb – 1 Mar");
  });

  it("adds the year to weeks of earlier years, so years of history stay unambiguous", () => {
    expect(formatWeekRange("2025-03-10", "2026-09-21")).toBe("10–16 Mar 2025");
    expect(formatWeekRange("2025-09-29", "2026-09-21")).toBe("29 Sep – 5 Oct 2025");
  });

  it("names both years when the week crosses New Year", () => {
    expect(formatWeekRange("2025-12-29", "2026-09-21")).toBe("29 Dec 2025 – 4 Jan 2026");
    expect(formatWeekRange("2025-12-29", "2025-12-29")).toBe("29 Dec 2025 – 4 Jan 2026");
  });

  it("counts a week across a DST change as seven calendar days (DST)", () => {
    // Clocks change on 25 Oct 2026 in Europe and 1 Nov 2026 in the US; the range only reads dates.
    expect(formatWeekRange("2026-10-19")).toBe("19–25 Oct");
    expect(formatWeekRange("2026-10-26")).toBe("26 Oct – 1 Nov");
  });

  it("shows the missing mark for null and malformed dates", () => {
    expect(formatWeekRange(null)).toBe(MISSING);
    expect(formatWeekRange("2026-02-30")).toBe(MISSING);
  });
});

describe("formatCountValue", () => {
  it("gives the count alone, thousands grouped", () => {
    expect(formatCountValue(4)).toBe("4");
    expect(formatCountValue(0)).toBe("0");
    expect(formatCountValue(1240)).toBe("1,240");
  });

  it("shows the missing mark for negative and non-finite counts", () => {
    expect(formatCountValue(-1)).toBe(MISSING);
    expect(formatCountValue(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });
});

describe("formatCount", () => {
  it("uses the singular for one and the plural otherwise", () => {
    expect(formatCount(1, "run", "runs")).toBe("1 run");
    expect(formatCount(0, "run", "runs")).toBe("0 runs");
    expect(formatCount(340, "run", "runs")).toBe("340 runs");
  });

  it("groups thousands", () => {
    expect(formatCount(1240, "run", "runs")).toBe("1,240 runs");
  });

  it("shows the missing mark for negative and non-finite counts", () => {
    expect(formatCount(-1, "run", "runs")).toBe(MISSING);
    expect(formatCount(Number.NaN, "run", "runs")).toBe(MISSING);
  });
});

describe("formatElevation", () => {
  it("shows whole meters with km and whole feet with mi, grouping thousands", () => {
    expect(formatElevation(64.4, "km")).toBe("64 m");
    expect(formatElevation(210.0, "mi")).toBe("210 ft");
    expect(formatElevation(1250.2, "mi")).toBe("1,250 ft");
    expect(formatElevation(0, "km")).toBe("0 m");
    expect(elevationUnitLabel("km")).toBe("m");
    expect(elevationUnitLabel("mi")).toBe("ft");
  });

  it("keeps elevation below sea level and never prints -0", () => {
    expect(formatElevationValue(-27.6)).toBe("-28");
    expect(formatElevationValue(-0.4)).toBe("0");
  });

  it("shows the missing mark for null and non-finite elevation", () => {
    expect(formatElevation(null, "km")).toBe(MISSING);
    expect(formatElevationValue(undefined)).toBe(MISSING);
    expect(formatElevationValue(Number.NaN)).toBe(MISSING);
  });
});

describe("formatCadence", () => {
  it("rounds to whole steps per minute", () => {
    expect(formatCadence(172)).toBe("172");
    expect(formatCadence(171.6)).toBe("172");
  });

  it("shows the missing mark when the watch recorded no cadence", () => {
    expect(formatCadence(null)).toBe(MISSING);
    expect(formatCadence(0)).toBe(MISSING);
    expect(formatCadence(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });
});

describe("formatCalories", () => {
  it("rounds to whole kilocalories and groups thousands", () => {
    expect(formatCalories(689.7)).toBe("690");
    expect(formatCalories(2840)).toBe("2,840");
  });

  it("shows the missing mark when Garmin estimated none", () => {
    expect(formatCalories(null)).toBe(MISSING);
    expect(formatCalories(0)).toBe(MISSING);
    expect(formatCalories(-5)).toBe(MISSING);
  });
});

describe("formatPercent", () => {
  it("rounds a share to a whole percent", () => {
    expect(formatPercent(0.478)).toBe("48%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("shows the missing mark for negative and non-finite shares", () => {
    expect(formatPercent(-0.1)).toBe(MISSING);
    expect(formatPercent(Number.NaN)).toBe(MISSING);
    expect(formatPercent(null)).toBe(MISSING);
  });
});

describe("formatLocalTime", () => {
  it("shows the wall-clock time of the run's own start", () => {
    expect(formatLocalTime("2026-09-27T07:12:00")).toBe("07:12");
    expect(formatLocalTime("2026-03-29T01:30:00")).toBe("01:30");
  });

  it("shows the missing mark for null and malformed values", () => {
    expect(formatLocalTime(null)).toBe(MISSING);
    expect(formatLocalTime("2026-09-27")).toBe(MISSING);
    expect(formatLocalTime("2026-02-30T07:12:00")).toBe(MISSING);
  });
});

describe("recordSeconds", () => {
  it("cuts a best effort's time to the whole second formatRecordTime shows, for the pace derived from it", () => {
    expect(recordSeconds(290.5)).toBe(290);
    expect(recordSeconds(1625.87)).toBe(1625);
    expect(recordSeconds(1625.9999999999998)).toBe(1626);
    expect(formatPace(recordSeconds(290.5), "km")).toBe("4:50 /km");
  });
});

describe("formatRecordTime", () => {
  it("cuts a record to the whole second the way Garmin shows it, never rounding up", () => {
    // The owner's PBs as Garmin lists them: 1625.87 s is 27:05, not 27:06.
    expect(formatRecordTime(1625.87)).toBe("27:05");
    expect(formatRecordTime(3281.4)).toBe("54:41");
    expect(formatRecordTime(5306.9)).toBe("1:28:26");
    expect(formatRecordTime(6972.6)).toBe("1:56:12");
  });

  it("reads m:ss under an hour and h:mm:ss from the hour (boundaries 59.99 s, 3599.9 s, 3600 s)", () => {
    expect(formatRecordTime(59.99)).toBe("0:59");
    expect(formatRecordTime(60)).toBe("1:00");
    expect(formatRecordTime(3599.9)).toBe("59:59");
    expect(formatRecordTime(3600)).toBe("1:00:00");
    expect(formatRecordTime(15_201.3)).toBe("4:13:21");
  });

  it("keeps a whole second that float sums left a hair short of it", () => {
    expect(formatRecordTime(1625.9999999999998)).toBe("27:06");
  });

  it("shows the missing mark for null, zero, negative and non-finite times", () => {
    expect(formatRecordTime(null)).toBe(MISSING);
    expect(formatRecordTime(undefined)).toBe(MISSING);
    expect(formatRecordTime(0)).toBe(MISSING);
    expect(formatRecordTime(-3)).toBe(MISSING);
    expect(formatRecordTime(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });
});

describe("formatLocalDate", () => {
  it("shows the calendar date of the run's own start, with its year", () => {
    expect(formatLocalDate("2026-09-27T07:12:00")).toBe("27 Sep 2026");
    expect(formatLocalDate("2019-04-07T23:55:00")).toBe("7 Apr 2019");
  });

  it("keeps the local day of a start in an hour that a DST change skips (time zones and DST)", () => {
    expect(formatLocalDate("2026-03-29T01:30:00")).toBe("29 Mar 2026");
  });

  it("shows the missing mark for null and malformed values", () => {
    expect(formatLocalDate(null)).toBe(MISSING);
    expect(formatLocalDate("27/09/2026")).toBe(MISSING);
    expect(formatLocalDate("2026-02-30T07:12:00")).toBe(MISSING);
  });
});

describe("formatPaceBand", () => {
  it("shows the fast end, then the slow end, then the unit", () => {
    expect(formatPaceBand(285, 292, "km")).toBe("4:45-4:52 /km");
    expect(formatPaceBand(458.7, 469.9, "mi")).toBe("7:39-7:50 /mi");
  });

  it("shows one pace when both ends round to the same second", () => {
    expect(formatPaceBand(285, 285.3, "km")).toBe("4:45 /km");
  });

  it("shows the missing mark when either end is missing", () => {
    expect(formatPaceBand(null, 292, "km")).toBe(MISSING);
    expect(formatPaceBand(285, 0, "km")).toBe(MISSING);
  });
});

describe("formatMeters", () => {
  it("shows whole meters without grouping", () => {
    expect(formatMeters(400)).toBe("400 m");
    expect(formatMeters(1000)).toBe("1000 m");
    expect(formatMeters(199.6)).toBe("200 m");
  });

  it("shows the missing mark for null, negative and non-finite values", () => {
    expect(formatMeters(null)).toBe(MISSING);
    expect(formatMeters(-1)).toBe(MISSING);
    expect(formatMeters(Number.NaN)).toBe(MISSING);
  });
});

describe("formatStepDistance", () => {
  it("drops the decimal of a whole distance and keeps one otherwise", () => {
    expect(formatStepDistance(1, "km")).toBe("1 km");
    expect(formatStepDistance(14, "km")).toBe("14 km");
    expect(formatStepDistance(1.5, "km")).toBe("1.5 km");
    expect(formatStepDistance(2.485, "mi")).toBe("2.5 mi");
  });

  it("drops the decimal when the distance rounds to a whole one (unit conversion)", () => {
    // A 1609 m step is a mile, not "1.0 mi".
    expect(formatStepDistance(1609 / 1609.344, "mi")).toBe("1 mi");
    expect(formatStepDistance(2.98, "km")).toBe("3 km");
  });

  it("shows the missing mark for null and negative values", () => {
    expect(formatStepDistance(null, "km")).toBe(MISSING);
    expect(formatStepDistance(-1, "km")).toBe(MISSING);
  });
});

describe("formatStepDuration", () => {
  it("says seconds, minutes and hours in words, leaving out the zero parts", () => {
    expect(formatStepDuration(45)).toBe("45 s");
    expect(formatStepDuration(900)).toBe("15 min");
    expect(formatStepDuration(150)).toBe("2 min 30 s");
    expect(formatStepDuration(5400)).toBe("1 h 30 min");
    expect(formatStepDuration(7200)).toBe("2 h");
  });

  it("shows the missing mark for null, zero and negative values", () => {
    expect(formatStepDuration(null)).toBe(MISSING);
    expect(formatStepDuration(0)).toBe(MISSING);
    expect(formatStepDuration(-60)).toBe(MISSING);
  });
});

describe("formatTwoDigits", () => {
  it("pads a minute or second to two digits like a clock", () => {
    expect(formatTwoDigits(0)).toBe("00");
    expect(formatTwoDigits(5)).toBe("05");
    expect(formatTwoDigits(59)).toBe("59");
  });

  it("shows the missing mark for a negative or non-finite figure", () => {
    expect(formatTwoDigits(-1)).toBe(MISSING);
    expect(formatTwoDigits(Number.NaN)).toBe(MISSING);
  });
});
