import { runner, runnerId, withDatabase } from "./seed";

// Connecting Garmin from the app: what the fixture Garmin's password login takes, and the one seed a connect
// through the screen needs.

/**
 * The fixture Garmin's password login (FakePasswordLogin in services/garmin/garmin_service/fake_client.py):
 * any email with this password asks for a code and this code finishes it; another code is refused and the
 * same login takes the next one. noCodeEmail connects without a code; rateLimitedEmail answers Garmin's 429
 * to any password. The runner signs in to Garmin with its own fictional email. Public test values, never a
 * real account's.
 */
export const fixtureGarminLogin = {
  email: runner.email,
  password: "fixture-password",
  code: "123456",
  wrongCode: "654321",
  noCodeEmail: "no-code@example.com",
  rateLimitedEmail: "rate-limited@example.com",
} as const;

/**
 * Where seed.ts's connectGarmin and seedExpiredGarminLogin leave the sync cursor, Sat 26 Sep 2026, 12:00 UTC:
 * a sync from it reads from 2026-09-25 and stores the fixture's 18 km run of Sun 27 Sep, whatever the date.
 */
const pinnedLastSyncAt = "2026-09-26T12:00:00Z";

/**
 * Pins the sync cursor of the connection a connect from the screen just stored. A first connect stores none,
 * so its sync reads the last 30 days, which hold no fixture run after about 2026-10-27; pinned, the sync the
 * screen sends next stores the 18 km run on any date. Call it while that sync is held (page.route), after
 * the connect has answered.
 */
export async function pinGarminSyncCursor(): Promise<void> {
  const pinned = await withDatabase((db) =>
    db.query(`update garmin_connection set last_sync_at = $2 where user_id = ${runnerId}`, [
      runner.email,
      pinnedLastSyncAt,
    ]),
  );
  if (pinned.rowCount !== 1) {
    throw new Error("Pinning the sync cursor found no Garmin connection for the runner");
  }
}
