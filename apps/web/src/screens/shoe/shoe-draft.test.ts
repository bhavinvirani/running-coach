import { describe, expect, it } from "vitest";
import { oldShoeFixture, shoeFixture } from "@/test/fixtures-shoes";
import { NEW_SHOE, checkDraft, draftFromInput, inputOf, type ShoeDraft } from "./shoe-draft";

const typed = (changes: Partial<ShoeDraft>, units: "km" | "mi" = "km"): ShoeDraft => ({
  ...draftFromInput(NEW_SHOE, units),
  brand: "Northpace",
  model: "Glide 4",
  ...changes,
});

describe("draftFromInput", () => {
  it("shows the goal in whole units and the distance before the app to a tenth (unit conversion)", () => {
    const old = inputOf(oldShoeFixture());
    expect(draftFromInput(old, "km")).toMatchObject({ retireAt: "650", startDistance: "100.0" });
    // 650 km is 403.9 mi; 100 km is 62.1 mi.
    expect(draftFromInput(old, "mi")).toMatchObject({ retireAt: "404", startDistance: "62.1" });
  });

  it("shows 0 for a pair that ran nothing before the app, and blanks for no colour or nickname", () => {
    expect(draftFromInput(NEW_SHOE, "km")).toEqual({
      brand: "",
      model: "",
      colour: "",
      nickname: "",
      retireAt: "650",
      startDistance: "0",
    });
  });
});

describe("checkDraft", () => {
  it("asks for the brand, then the model", () => {
    expect(checkDraft(typed({ brand: "  " }), NEW_SHOE, "km")).toEqual({
      success: false,
      message: "Type the brand.",
    });
    expect(checkDraft(typed({ model: "" }), NEW_SHOE, "km")).toEqual({
      success: false,
      message: "Type the model.",
    });
  });

  it("trims the names and sends a blank colour or nickname as null", () => {
    const checked = checkDraft(
      typed({ brand: " Northpace ", colour: " ", nickname: " Daily " }),
      NEW_SHOE,
      "km",
    );
    expect(checked).toEqual({
      success: true,
      input: {
        brand: "Northpace",
        model: "Glide 4",
        colour: null,
        nickname: "Daily",
        retireDistanceM: 650_000,
        startDistanceM: 0,
      },
    });
  });

  it("keeps the stored meters of a goal left as shown in miles (unit conversion)", () => {
    const checked = checkDraft(typed({}, "mi"), NEW_SHOE, "mi");
    // 404 mi would be 650175 m.
    expect(checked).toMatchObject({ success: true, input: { retireDistanceM: 650_000 } });
  });

  it("keeps the stored meters of a distance before the app left as shown (unit conversion)", () => {
    const old = inputOf(oldShoeFixture({ startDistanceM: 100_123 }));
    const checked = checkDraft(draftFromInput(old, "mi"), old, "mi");
    expect(checked).toMatchObject({
      success: true,
      input: { retireDistanceM: 650_000, startDistanceM: 100_123 },
    });
  });

  it("converts a changed distance from miles to whole meters (unit conversion)", () => {
    const checked = checkDraft(
      typed({ retireAt: "300", startDistance: "12.5" }, "mi"),
      NEW_SHOE,
      "mi",
    );
    // 300 × 1609.344 = 482803.2; 12.5 × 1609.344 = 20116.8.
    expect(checked).toMatchObject({
      success: true,
      input: { retireDistanceM: 482_803, startDistanceM: 20_117 },
    });
  });

  it("takes a blank distance before the app as none", () => {
    const old = inputOf(oldShoeFixture());
    const checked = checkDraft({ ...draftFromInput(old, "km"), startDistance: " " }, old, "km");
    expect(checked).toMatchObject({ success: true, input: { startDistanceM: 0 } });
  });

  it.each([
    { units: "km", retireAt: "49", message: "Retire at is a distance from 50 to 5,000 km." },
    { units: "km", retireAt: "5001", message: "Retire at is a distance from 50 to 5,000 km." },
    { units: "km", retireAt: "", message: "Retire at is a distance from 50 to 5,000 km." },
    { units: "mi", retireAt: "31", message: "Retire at is a distance from 32 to 3,106 mi." },
    { units: "mi", retireAt: "4oo", message: "Retire at is a distance from 32 to 3,106 mi." },
  ] as const)(
    "says the goal's range in $units for $retireAt (unit conversion)",
    ({ units, retireAt, message }) => {
      expect(checkDraft(typed({ retireAt }, units), NEW_SHOE, units)).toEqual({
        success: false,
        message,
      });
    },
  );

  it.each([
    { units: "km", startDistance: "5000.1", message: "from 0 to 5,000 km" },
    { units: "mi", startDistance: "3107", message: "from 0 to 3,106 mi" },
    { units: "km", startDistance: "-3", message: "from 0 to 5,000 km" },
  ] as const)(
    "says the distance before the app's range in $units for $startDistance (unit conversion)",
    ({ units, startDistance, message }) => {
      expect(checkDraft(typed({ startDistance }, units), NEW_SHOE, units)).toEqual({
        success: false,
        message: `Distance before this app is a distance ${message}.`,
      });
    },
  );

  it("accepts the ends of the ranges it states", () => {
    expect(checkDraft(typed({ retireAt: "32" }, "mi"), NEW_SHOE, "mi").success).toBe(true);
    expect(
      checkDraft(typed({ retireAt: "3106", startDistance: "3106" }, "mi"), NEW_SHOE, "mi").success,
    ).toBe(true);
    expect(
      checkDraft(typed({ retireAt: "50", startDistance: "5000" }, "km"), NEW_SHOE, "km").success,
    ).toBe(true);
  });

  it("edits a stored pair without touching what was not changed", () => {
    const daily = inputOf(shoeFixture());
    const checked = checkDraft(
      { ...draftFromInput(daily, "km"), nickname: "Easy days" },
      daily,
      "km",
    );
    expect(checked).toEqual({ success: true, input: { ...daily, nickname: "Easy days" } });
  });
});
