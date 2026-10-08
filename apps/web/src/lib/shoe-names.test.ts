import { describe, expect, it } from "vitest";
import { oldShoeFixture, racerShoeFixture, shoeFixture } from "@/test/fixtures-shoes";
import { brandAndModel, shoeDetails, shoeName, shoeStatus } from "./shoe-names";

describe("shoeName", () => {
  it("is the nickname when the runner gave one", () => {
    expect(shoeName(shoeFixture())).toBe("Daily trainer");
  });

  it("is brand and model without a nickname", () => {
    expect(shoeName(racerShoeFixture())).toBe("Northpace Flyer 2");
    expect(brandAndModel(racerShoeFixture())).toBe("Northpace Flyer 2");
  });
});

describe("shoeDetails", () => {
  it("names brand and model under a nickname, then the colour", () => {
    expect(shoeDetails(shoeFixture())).toEqual(["Northpace Glide 4", "Blue"]);
  });

  it("leaves out brand and model already in the name, and a colour never set", () => {
    expect(shoeDetails(racerShoeFixture())).toEqual([]);
    expect(shoeDetails(racerShoeFixture({ colour: "Orange" }))).toEqual(["Orange"]);
  });
});

describe("shoeStatus", () => {
  it("says Active, In use or Retired", () => {
    expect(shoeStatus(shoeFixture())).toBe("Active");
    expect(shoeStatus(racerShoeFixture())).toBe("In use");
    expect(shoeStatus(oldShoeFixture())).toBe("Retired");
  });
});
