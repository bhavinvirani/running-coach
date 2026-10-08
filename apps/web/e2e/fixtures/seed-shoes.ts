import { DEFAULT_SHOE_RETIRE_DISTANCE_M } from "@running-coach/shared";
import { UNCATEGORIZED, runner, runnerId, withDatabase } from "./seed";

// The shoes' seeds (slice 52): the runner's pairs, written as POST /api/shoes stores them, and runs that
// wear them. The brand and models are made up. A pair's distance, runs and time are summed from its runs
// when the API reads it, so each pair here is a start distance plus the runs seeded on it.

/** A pair's names, as the runner types them. */
export type SeededPair = {
  brand: string;
  model: string;
  colour: string | null;
  nickname: string | null;
};

export const pairs = {
  /** "Northpace Glide 4", in Slate. */
  glide: { brand: "Northpace", model: "Glide 4", colour: "Slate", nickname: null },
  /** "Northpace Ridge 2", in Moss. */
  ridge: { brand: "Northpace", model: "Ridge 2", colour: "Moss", nickname: null },
  /** "Race day": a nickname, so the line under it names the brand and model. */
  raceDay: { brand: "Northpace", model: "Tempo Elite", colour: null, nickname: "Race day" },
} as const satisfies Record<string, SeededPair>;

/** How a seeded pair stands; every field has the API's default for a new pair. */
export type SeededPairState = {
  active?: boolean;
  /** Set for a retired pair, which is never active. */
  retiredAt?: string;
  retireDistanceM?: number;
  startDistanceM?: number;
  /** When it was added: the list shows the pairs in use newest first. */
  createdAt?: string;
};

/** Stores one of the runner's pairs directly and returns its id. */
export async function seedPair(
  pair: SeededPair,
  {
    active = false,
    retiredAt,
    retireDistanceM = DEFAULT_SHOE_RETIRE_DISTANCE_M,
    startDistanceM = 0,
    createdAt = "2026-08-01T09:00:00Z",
  }: SeededPairState = {},
): Promise<string> {
  const { rows } = await withDatabase((db) =>
    db.query<{ id: string }>(
      `insert into shoe (user_id, brand, model, colour, nickname, retire_distance_m, start_distance_m,
         active, retired_at, created_at, updated_at)
       values (${runnerId}, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       returning id`,
      [
        runner.email,
        pair.brand,
        pair.model,
        pair.colour,
        pair.nickname,
        retireDistanceM,
        startDistanceM,
        active,
        retiredAt ?? null,
        createdAt,
      ],
    ),
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`The pair ${pair.brand} ${pair.model} was not stored`);
  return id;
}

/** Puts a pair on a stored run, by the run's Garmin id, as the sync or the run screen leaves it. */
export async function wearPair(garminActivityId: number, shoeId: string): Promise<void> {
  const { rowCount } = await withDatabase((db) =>
    db.query(
      `update activity set shoe_id = $3 where user_id = ${runnerId} and garmin_activity_id = $2`,
      [runner.email, garminActivityId, shoeId],
    ),
  );
  if (rowCount !== 1) throw new Error(`No stored run has Garmin id ${garminActivityId}`);
}

/** A run worn in a pair: its local date, how far and how long. */
type PairRun = { date: string; distanceM: number; durationS: number };

/** Garmin ids for the runs seeded on pairs: one per local date, far from every other seed's. */
const PAIR_RUN_IDS = 40_000_000_000;

/**
 * Stores fictional outdoor runs at 07:30 on their dates (UTC, the runner's default zone), each wearing the
 * pair. The fixture Garmin never lists them, so a test that stores them must not sync.
 */
async function seedRunsInPair(shoeId: string, runs: readonly PairRun[]): Promise<void> {
  await withDatabase(async (db) => {
    for (const { date, distanceM, durationS } of runs) {
      await db.query(
        `insert into activity (user_id, garmin_activity_id, type, start_utc, start_local, distance_m,
           duration_s, event_type, shoe_id)
         values (${runnerId}, $2, 'running', $3::timestamp at time zone 'UTC', $3, $4, $5, $6, $7)`,
        [
          runner.email,
          PAIR_RUN_IDS + Number(date.replaceAll("-", "")),
          `${date} 07:30:00`,
          distanceM,
          durationS,
          UNCATEGORIZED,
          shoeId,
        ],
      );
    }
  });
}

/**
 * The Shoes list's capture: three pairs, each with runs, so every row has a distance, a bar, runs and time.
 * - Glide 4, active: 250 km before the app plus 10, 8 and 18 km is "286.0 of 650 km", 3 runs in 3:22:00.
 * - Race day, in use: one 10.2 km race is "10.2 of 400 km", 1 run in 55:00.
 * - Ridge 2, retired on 1 Sep: 640 km before the app plus 14 and 6.5 km is "660.5 of 650 km", 10.5 km
 *   past its retire distance, 2 runs in 1:55:00.
 */
export async function seedShoesList(): Promise<void> {
  const glide = await seedPair(pairs.glide, {
    active: true,
    startDistanceM: 250_000,
    createdAt: "2026-08-20T09:00:00Z",
  });
  await seedRunsInPair(glide, [
    { date: "2026-09-21", distanceM: 10_000, durationS: 3300 },
    { date: "2026-09-23", distanceM: 8000, durationS: 2700 },
    { date: "2026-09-27", distanceM: 18_000, durationS: 6120 },
  ]);

  const raceDay = await seedPair(pairs.raceDay, {
    retireDistanceM: 400_000,
    createdAt: "2026-08-10T09:00:00Z",
  });
  await seedRunsInPair(raceDay, [{ date: "2026-09-06", distanceM: 10_200, durationS: 3300 }]);

  const ridge = await seedPair(pairs.ridge, {
    retiredAt: "2026-09-01T18:00:00Z",
    startDistanceM: 640_000,
    createdAt: "2026-03-01T09:00:00Z",
  });
  await seedRunsInPair(ridge, [
    { date: "2026-08-16", distanceM: 14_000, durationS: 4620 },
    { date: "2026-08-22", distanceM: 6500, durationS: 2280 },
  ]);
}
