import {
  shoeSchema,
  shoesResponseSchema,
  type Shoe,
  type ShoesResponse,
} from "@running-coach/shared";

// Shoes (issue #52): a fictional runner's three pairs of a made-up brand. The daily trainer is active at
// 312.4 of 650 km over 41 runs; the racer is in use, not active; the old trainer is retired 52.3 km past
// its goal.

export const DAILY_SHOE_ID = "5e0d4c3b-2a19-4f8e-9d7c-6b5a4f3e2d1c";
export const RACER_SHOE_ID = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
export const OLD_SHOE_ID = "9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f";

/** The active pair, parsed with the shared contract like meFixture. */
export function shoeFixture(overrides: Partial<Shoe> = {}): Shoe {
  return shoeSchema.parse({
    id: DAILY_SHOE_ID,
    brand: "Northpace",
    model: "Glide 4",
    colour: "Blue",
    nickname: "Daily trainer",
    retireDistanceM: 650_000,
    startDistanceM: 0,
    active: true,
    retiredAt: null,
    distanceM: 312_400,
    runs: 41,
    // 28:14:05
    durationS: 101_645,
    ...overrides,
  });
}

/** A pair in use but not active, without nickname or colour, so it goes by brand and model. */
export function racerShoeFixture(overrides: Partial<Shoe> = {}): Shoe {
  return shoeFixture({
    id: RACER_SHOE_ID,
    model: "Flyer 2",
    colour: null,
    nickname: null,
    retireDistanceM: 400_000,
    active: false,
    distanceM: 84_200,
    runs: 9,
    // 6:52:30
    durationS: 24_750,
    ...overrides,
  });
}

/** A retired pair that ran 702.3 km, 52.3 past its 650 km goal, 100 of them before the app. */
export function oldShoeFixture(overrides: Partial<Shoe> = {}): Shoe {
  return shoeFixture({
    id: OLD_SHOE_ID,
    model: "Glide 3",
    colour: "Grey",
    nickname: "Old trainer",
    startDistanceM: 100_000,
    active: false,
    retiredAt: "2026-08-30T10:00:00Z",
    distanceM: 702_300,
    runs: 88,
    // 61:20:00
    durationS: 220_800,
    ...overrides,
  });
}

/** GET /api/shoes, in the API's order: active, then in use, then retired. */
export function shoesResponseFixture(
  shoes: Shoe[] = [shoeFixture(), racerShoeFixture(), oldShoeFixture()],
): ShoesResponse {
  return shoesResponseSchema.parse({ shoes });
}
