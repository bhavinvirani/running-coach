import { describe, expect, it } from "vitest";
import { parseDuration } from "./parse-duration";

describe("parseDuration", () => {
  it("reads mm:ss and m:ss", () => {
    expect(parseDuration("49:30")).toBe(2970);
    expect(parseDuration("5:07")).toBe(307);
    expect(parseDuration("00:59")).toBe(59);
  });

  it("reads h:mm:ss", () => {
    expect(parseDuration("1:45:00")).toBe(6300);
    expect(parseDuration("3:59:59")).toBe(14399);
    expect(parseDuration("01:05:09")).toBe(3909);
  });

  it("reads minutes past the hour as mm:ss, the way a marathon split is sometimes typed", () => {
    expect(parseDuration("105:00")).toBe(6300);
  });

  it("ignores spaces around the time", () => {
    expect(parseDuration("  25:00 ")).toBe(1500);
  });

  it.each([
    "",
    "   ",
    "25",
    "abc",
    "25:7",
    "25:60",
    "1:60:00",
    "1:5:00",
    "1:05:7",
    "-5:00",
    "1:2:3:4",
  ])("rejects %j", (text) => {
    expect(parseDuration(text)).toBeNull();
  });

  it("rejects a zero time", () => {
    expect(parseDuration("0:00")).toBeNull();
    expect(parseDuration("0:00:00")).toBeNull();
  });
});
