import { describe, expect, it } from "vitest";
import { exampleRun } from "./example-run";

describe("exampleRun", () => {
  it("shows the run in kilometers, pace per kilometer and meters of climb (unit conversion)", () => {
    expect(exampleRun("km")).toBe("10.0 km at 5:30 /km, 120 m climb");
  });

  it("shows the same run in miles, pace per mile and feet of climb (unit conversion)", () => {
    expect(exampleRun("mi")).toBe("6.2 mi at 8:51 /mi, 394 ft climb");
  });
});
