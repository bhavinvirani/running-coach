import type { DistanceKey } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { DISTANCE_KEYS } from "@/lib/distance-labels";
import { longestFirst } from "./best-effort-order";

type Tile = { distanceKey: DistanceKey; time: number | null };

const tile = (distanceKey: DistanceKey, time: number | null = 100): Tile => ({ distanceKey, time });
const keys = (tiles: readonly Tile[]) => tiles.map((item) => item.distanceKey);

describe("longestFirst", () => {
  it("puts every distance longest first, marathon to 1K", () => {
    expect(keys(longestFirst(DISTANCE_KEYS.map((key) => tile(key))))).toEqual([
      "marathon",
      "half",
      "20k",
      "10mi",
      "15k",
      "10k",
      "5mi",
      "5k",
      "2mi",
      "1mi",
      "1k",
    ]);
  });

  it("orders a run's efforts longest first whatever order they arrive in", () => {
    expect(keys(longestFirst([tile("1k"), tile("10k"), tile("1mi"), tile("5k")]))).toEqual([
      "10k",
      "5k",
      "1mi",
      "1k",
    ]);
  });

  it("puts the distances with no time at the end, longest first among themselves too (no run yet)", () => {
    const tiles = DISTANCE_KEYS.map((key) =>
      tile(key, ["1k", "5k", "10k", "10mi", "half"].includes(key) ? 100 : null),
    );

    expect(keys(longestFirst(tiles, (item) => item.time !== null))).toEqual([
      "half",
      "10mi",
      "10k",
      "5k",
      "1k",
      "marathon",
      "20k",
      "15k",
      "5mi",
      "2mi",
      "1mi",
    ]);
  });

  it("keeps a longer distance with no time behind a shorter one with a time", () => {
    const tiles = [tile("marathon", null), tile("1k")];

    expect(keys(longestFirst(tiles, (item) => item.time !== null))).toEqual(["1k", "marathon"]);
  });

  it("returns a new array and leaves the one given alone", () => {
    const tiles = [tile("1k"), tile("5k")];

    const ordered = longestFirst(tiles);

    expect(ordered).not.toBe(tiles);
    expect(keys(tiles)).toEqual(["1k", "5k"]);
  });

  it("returns nothing for nothing (a run without efforts)", () => {
    expect(longestFirst([])).toEqual([]);
  });
});
