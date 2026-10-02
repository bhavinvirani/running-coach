import { ErrorCode } from "@running-coach/shared";
import { eq, type SQL, sql } from "drizzle-orm";
import { type Db, type DbTransaction, db } from "../db/client";
import { garminConnection, userSettings } from "../db/schema";
import { DEFAULT_RETRY_AFTER_S, type GarminCallOptions } from "../garmin/client";
import { decrypt, encrypt } from "../lib/crypto";
import { DomainError } from "../lib/errors";

// A user's Garmin login as every service that calls Garmin for them uses it (sync, history import): the
// gates that keep a dead or rate-limited login away from Garmin, the write-back of a rotated bundle, and the
// failure and success bookkeeping on garmin_connection. Callers hold withUserLock(userId) around all of it.

export function garminNotConnected(): DomainError {
  return new DomainError(ErrorCode.garminNotConnected, 409, "Connect Garmin first.");
}

export function garminAuthExpired(): DomainError {
  return new DomainError(
    ErrorCode.garminAuthExpired,
    409,
    "Garmin rejected the saved login. Connect Garmin again.",
  );
}

async function readConnection(userId: string) {
  const [row] = await db
    .select({
      tokenBundleEnc: garminConnection.tokenBundleEnc,
      status: garminConnection.status,
      lastSyncAt: garminConnection.lastSyncAt,
      lastError: garminConnection.lastError,
      updatedAt: garminConnection.updatedAt,
      timezone: userSettings.timezone,
    })
    .from(garminConnection)
    // Every user gets a settings row at creation (auth.ts), so the join never drops a connection.
    .innerJoin(userSettings, eq(userSettings.userId, garminConnection.userId))
    .where(eq(garminConnection.userId, userId));
  return row;
}

export type GarminConnectionRow = NonNullable<Awaited<ReturnType<typeof readConnection>>>;

/** The user's connection, or garmin_not_connected; garmin_auth_expired once the login is marked expired. */
export async function requireGarminConnection(userId: string): Promise<GarminConnectionRow> {
  const connection = await readConnection(userId);
  if (!connection) throw garminNotConnected();
  // A known-dead login is not sent again: failed logins are what Garmin rate-limits hardest.
  if (connection.status === "expired") throw garminAuthExpired();
  return connection;
}

/**
 * Seconds left of the hour a Garmin 429 blocks the login, or 0 when none is running. updated_at marks the
 * 429: recordFailure wrote last_error then, and nothing else changes the row until a finished call
 * (recordGarminSuccess) or a reconnect clears last_error, which ends the hour early.
 */
function rateLimitSecondsLeft(connection: { lastError: string | null; updatedAt: Date }): number {
  if (connection.lastError !== ErrorCode.garminRateLimited) return 0;
  const leftMs = connection.updatedAt.getTime() + DEFAULT_RETRY_AFTER_S * 1000 - Date.now();
  if (leftMs <= 0) return 0;
  return Math.min(DEFAULT_RETRY_AFTER_S, Math.max(1, Math.ceil(leftMs / 1000)));
}

/**
 * Stores a bundle Garmin rotated, at once and on its own connection: the old refresh token is dead, so this
 * write must survive whatever fails next.
 */
async function saveTokenBundle(userId: string, tokenBundle: string): Promise<void> {
  await db
    .update(garminConnection)
    .set({ tokenBundleEnc: encrypt(tokenBundle, userId) })
    .where(eq(garminConnection.userId, userId));
}

/**
 * Stores the error code. Only a second garmin_auth_expired in a row marks the login expired: the library
 * swallows a failed token refresh (a 429 or a block on the token endpoint) and reports it as the same 401,
 * and an expired connection is never tried again until the runner reconnects with 2FA. The next call
 * confirms it with one token login. A success in between clears lastError (recordGarminSuccess).
 */
async function recordFailure(userId: string, error: unknown): Promise<void> {
  const code = error instanceof DomainError ? error.code : ErrorCode.internal;
  await db
    .update(garminConnection)
    .set({
      lastError: code,
      ...(code === ErrorCode.garminAuthExpired
        ? {
            status: sql`case when ${garminConnection.lastError} = ${code} then 'expired' else ${garminConnection.status} end`,
          }
        : {}),
    })
    .where(eq(garminConnection.userId, userId));
}

/**
 * Marks the login working after a finished Garmin call: status ok, last error cleared (which also ends a
 * 429 hour). `set` adds the caller's own columns to the same update, such as the sync's cursor. Runs in the
 * caller's transaction, so it commits with the rows the call produced.
 */
export async function recordGarminSuccess(
  executor: Db | DbTransaction,
  userId: string,
  set: { lastSyncAt?: SQL } = {},
): Promise<void> {
  await executor
    .update(garminConnection)
    .set({ ...set, status: "ok", lastError: null })
    .where(eq(garminConnection.userId, userId));
}

export interface GarminAccount {
  connection: GarminConnectionRow;
  /**
   * Runs one Garmin call with the live bundle: the stored one, or the last one Garmin rotated, which is
   * written back the moment the client hands it over, before the call returns or throws. A failure is
   * recorded on the connection and rethrown.
   */
  call<T>(fn: (tokenBundle: string, options: GarminCallOptions) => Promise<T>): Promise<T>;
}

/**
 * Opens the user's Garmin login for calls, inside withUserLock. Refuses without a connection or with an
 * expired one (409), and during the hour after a Garmin 429 (garmin_rate_limited with the seconds left)
 * without calling Garmin: every try during the block is another login, which can stretch it. The refusal
 * writes nothing, so a tap never pushes the hour forward.
 */
export async function openGarminAccount(userId: string): Promise<GarminAccount> {
  const connection = await requireGarminConnection(userId);
  const retryAfterSeconds = rateLimitSecondsLeft(connection);
  if (retryAfterSeconds > 0) {
    throw new DomainError(
      ErrorCode.garminRateLimited,
      429,
      "Garmin is limiting requests. Try again later.",
      { retryAfterSeconds },
    );
  }

  let bundle = decrypt(connection.tokenBundleEnc, userId);
  const onTokenBundle = async (rotated: string): Promise<void> => {
    await saveTokenBundle(userId, rotated);
    bundle = rotated;
  };
  return {
    connection,
    async call(fn) {
      try {
        return await fn(bundle, { onTokenBundle });
      } catch (error) {
        // A 404 for one run (deleted on Garmin Connect) is an answer from a working login, so it counts as a
        // finished call: recording it as a failure would reset the expiry strike or hide a 429 hour.
        if (error instanceof DomainError && error.code === ErrorCode.notFound) {
          await recordGarminSuccess(db, userId);
        } else {
          await recordFailure(userId, error);
        }
        throw error;
      }
    },
  };
}
