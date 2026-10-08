import pino from "pino";
import { vi } from "vitest";
import type { PlanSessionRow } from "../src/db/schema";
import { addDays, localDateOf } from "../src/lib/local-date";
import { logger } from "../src/lib/logger";
import { createSession } from "./seed";

// Rows and inputs for the web Garmin login and disconnect (routes/garmin-login, garmin-disconnect).

/**
 * The fixture Garmin's password login (services/garmin fake_client.py FakePasswordLogin): any email with
 * this password asks for a code, the code finishes it with the base bundle (garminBundle()); the two
 * special emails connect without a code and answer Garmin's 429. Made-up values, all of them.
 */
export const FIXTURE_LOGIN = {
  email: "alex.fixture@example.com",
  password: "fixture-password",
  code: "123456",
  wrongCode: "987650",
  noCodeEmail: "no-code@example.com",
  rateLimitedEmail: "rate-limited@example.com",
} as const;

/** The local date `days` from today in the zone (UTC, the default settings), for rows the routes read. */
export function localDay(days: number, timeZone = "UTC", now = new Date()): string {
  return addDays(localDateOf(now, timeZone), days);
}

let lastFakeId = 0;

/**
 * A session the push already put on Garmin: fake workout and schedule ids of its own, scheduled on its
 * date (or on `garminDate`), with a stored content hash. Planned unless `status` says otherwise.
 */
export async function createHeldSession(
  userId: string,
  planId: string | null,
  date: string,
  values: Partial<Pick<PlanSessionRow, "status" | "garminDate">> = {},
): Promise<PlanSessionRow> {
  lastFakeId += 1;
  return createSession(userId, planId, {
    date,
    garminWorkoutId: String(910_000_000 + lastFakeId),
    garminScheduleId: String(810_000_000 + lastFakeId),
    garminDate: date,
    garminHash: "a".repeat(64),
    ...values,
  });
}

type LogStream = { write(line: string): boolean };

/**
 * Every line the app's logger and its children (pino-http's too) write from now on, as written; none
 * reaches stdout meanwhile. A file using it raises LOG_LEVEL before the config loads (vi.hoisted), since
 * vitest.config.ts sets it silent.
 */
export function captureAppLogs(): () => string[] {
  const stream = (logger as unknown as Record<symbol, LogStream>)[pino.symbols.streamSym];
  if (!stream) throw new Error("the logger has no stream");
  const lines: string[] = [];
  vi.spyOn(stream, "write").mockImplementation((line: string) => {
    lines.push(line);
    return true;
  });
  return () => lines;
}
