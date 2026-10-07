import { describe, expect, it } from "vitest";
import { hrZonesFixture } from "@/test/fixtures-hr-zones";
import {
  checkDraft,
  draftFromZones,
  withBpm,
  withMaxHr,
  withPercent,
  zoneRange,
  type ZonesDraft,
} from "./zones-draft";

/** Max HR 196 with floors at 98, 118, 137, 157 and 176 bpm: 50, 60, 70, 80 and 90 %. */
const garmin = () => draftFromZones(hrZonesFixture());

const bpms = (draft: ZonesDraft) => draft.zones.map((zone) => zone.bpm);
const percents = (draft: ZonesDraft) => draft.zones.map((zone) => zone.percent);

describe("draftFromZones", () => {
  it("shows each floor in bpm and as a whole percent of max HR", () => {
    const draft = garmin();
    expect(draft.maxHr).toBe("196");
    expect(bpms(draft)).toEqual(["98", "118", "137", "157", "176"]);
    expect(percents(draft)).toEqual(["50", "60", "70", "80", "90"]);
  });
});

describe("withPercent", () => {
  it("moves the zone's bpm to that share of max HR and leaves the other zones", () => {
    const draft = withPercent(garmin(), 1, "65");
    expect(draft.zones[1]).toMatchObject({ percent: "65", bpm: "127" });
    expect(bpms(draft)).toEqual(["98", "127", "137", "157", "176"]);
  });

  it("keeps the bpm while the percent is empty or not a whole number", () => {
    expect(withPercent(garmin(), 1, "").zones[1]).toMatchObject({ percent: "", bpm: "118" });
    expect(withPercent(garmin(), 1, "6.5").zones[1]).toMatchObject({ percent: "6.5", bpm: "118" });
  });

  it("keeps the bpm while there is no max HR to take a share of", () => {
    const draft = withPercent(withMaxHr(garmin(), ""), 1, "65");
    expect(draft.zones[1]).toMatchObject({ percent: "65", bpm: "118" });
  });
});

describe("withBpm", () => {
  it("moves the zone's percent to the new bpm's share of max HR", () => {
    const draft = withBpm(garmin(), 3, "167");
    expect(draft.zones[3]).toMatchObject({ percent: "85", bpm: "167" });
  });

  it("keeps the percent while the bpm is half typed", () => {
    expect(withBpm(garmin(), 3, "").zones[3]).toMatchObject({ percent: "80", bpm: "" });
  });

  it("keeps the percent at a max HR of 0 instead of dividing by it", () => {
    const draft = withBpm(withMaxHr(garmin(), "0"), 3, "167");
    expect(draft.zones[3]).toMatchObject({ percent: "80", bpm: "167" });
  });
});

describe("withMaxHr", () => {
  it("keeps every percent and moves every bpm to that share of the new max HR", () => {
    const draft = withMaxHr(garmin(), "200");
    expect(percents(draft)).toEqual(["50", "60", "70", "80", "90"]);
    expect(bpms(draft)).toEqual(["100", "120", "140", "160", "180"]);
  });

  it("brings the bpm back once a half-typed max HR is whole again, the percents kept throughout", () => {
    const typing = withMaxHr(withMaxHr(garmin(), "1"), "19");
    expect(percents(typing)).toEqual(["50", "60", "70", "80", "90"]);
    expect(bpms(withMaxHr(typing, "196"))).toEqual(["98", "118", "137", "157", "176"]);
  });

  it("moves a zone whose percent is half typed by its share and fills the percent back in", () => {
    const draft = withMaxHr(withPercent(garmin(), 0, ""), "200");
    expect(draft.zones[0]).toMatchObject({ percent: "50", bpm: "100" });
  });

  it("gives floors that are not whole percents back exactly when the same max HR is typed again", () => {
    const lthr = () => draftFromZones({ maxHr: 196, lowBpm: [120, 134, 148, 162, 176] });
    const retyped = withMaxHr(withMaxHr(withMaxHr(lthr(), "1"), "19"), "196");
    expect(bpms(retyped)).toEqual(["120", "134", "148", "162", "176"]);
    const awayAndBack = withMaxHr(withMaxHr(lthr(), "190"), "196");
    expect(bpms(awayAndBack)).toEqual(["120", "134", "148", "162", "176"]);
  });

  it("keeps a typed bpm when max HR moves away and back", () => {
    const typed = withBpm(garmin(), 1, "130");
    expect(bpms(withMaxHr(withMaxHr(typed, "190"), "196"))[1]).toBe("130");
  });

  it("takes the share from a bpm typed while there was no max HR", () => {
    const draft = withMaxHr(withBpm(withMaxHr(garmin(), ""), 1, "120"), "200");
    expect(draft.zones[1]).toMatchObject({ percent: "60", bpm: "120" });
  });
});

describe("zoneRange", () => {
  it("runs from the zone's floor to the bpm before the next zone, the last one to max HR", () => {
    const draft = garmin();
    expect(zoneRange(draft, 0)).toBe("98-117 bpm");
    expect(zoneRange(draft, 1)).toBe("118-136 bpm");
    expect(zoneRange(draft, 4)).toBe("176-196 bpm");
  });

  it("shows the dash while a bound is missing or the zones overlap", () => {
    expect(zoneRange(withBpm(garmin(), 2, ""), 1)).toBe("–");
    expect(zoneRange(withBpm(garmin(), 2, "110"), 1)).toBe("–");
  });
});

describe("checkDraft", () => {
  it("gives the zones to save as numbers", () => {
    expect(checkDraft(withPercent(garmin(), 1, "65"))).toEqual({
      success: true,
      zones: { maxHr: 196, lowBpm: [98, 127, 137, 157, 176] },
    });
  });

  it("says each zone must start above the one before (invalid zones)", () => {
    expect(checkDraft(withBpm(garmin(), 2, "110"))).toEqual({
      success: false,
      message: "Each zone starts above the one before it.",
    });
  });

  it("says zone 5 must start below max HR (invalid zones)", () => {
    expect(checkDraft(withBpm(garmin(), 4, "196"))).toEqual({
      success: false,
      message: "Zone 5 starts below max HR.",
    });
  });

  it("says zone 1 must start at 30 bpm or more (invalid zones)", () => {
    expect(checkDraft(withBpm(garmin(), 0, "25"))).toEqual({
      success: false,
      message: "Zone 1 starts at 30 bpm or more.",
    });
  });

  it("names max HR when it is out of range or not a whole number (invalid zones)", () => {
    const message = "Max HR is a whole number from 100 to 240 bpm.";
    expect(checkDraft(withMaxHr(garmin(), "250"))).toEqual({ success: false, message });
    expect(checkDraft({ ...garmin(), maxHr: "" })).toEqual({ success: false, message });
  });

  it("names a zone whose percent is empty or not whole, so nothing unseen is saved (invalid zones)", () => {
    const message = "Zone 2 starts at a whole percent of max HR.";
    expect(checkDraft(withPercent(garmin(), 1, ""))).toEqual({ success: false, message });
    expect(checkDraft(withPercent(garmin(), 1, "62.5"))).toEqual({ success: false, message });
  });

  it("names the zone whose bpm is not a whole number (invalid zones)", () => {
    expect(checkDraft(withBpm(garmin(), 1, "1a8"))).toEqual({
      success: false,
      message: "Zone 2 starts at a whole number of bpm.",
    });
  });
});
