import type { SendOptions } from "pg-boss";
import { z } from "zod";
import { deterministicJobId, getBoss } from "./boss";

// The import-history queue without its handler (import-history.ts): POST /api/import queues the first page
// through these from services/history-import.ts, which the handler imports, so they cannot live beside it.

export const name = "import-history";

/** Only the user: every page reads its offset from import_progress, so a page job never runs a stale one. */
export const data = z.object({ userId: z.uuid() }).strict();
export type ImportHistoryData = z.infer<typeof data>;

/**
 * "stately": per user (singletonKey), at most one page queued and one active. A page that is running can
 * queue its successor, and a resume while a page waits folds into that page.
 */
export const queue = { policy: "stately" } as const;

export const jobOptions = {
  // Every attempt is a new Garmin login and the service already retried inside its session: two retries,
  // 5 to 10 and then 10 to 20 minutes later, as for sync.
  retryLimit: 2,
  retryBackoff: true,
  retryDelay: 5 * 60,
  retryDelayMax: 30 * 60,
  // One page is one Garmin call of up to 60 s, but it may first wait on the user lock behind a sync.
  expireInSeconds: 10 * 60,
} satisfies SendOptions;

/**
 * The successor of the page that moved the import begun at startedAt to nextOffset. Keyed on both, so the
 * same page queueing its successor twice queues it once, and a new import never collides with an old one.
 * The first page and resumes go without an id: the stately queue folds them into a waiting page.
 */
export function pageJobId(userId: string, startedAt: Date, nextOffset: number): string {
  return deterministicJobId(`${name}:${userId}:${startedAt.toISOString()}:${nextOffset}`);
}

export function sendOptions(job: ImportHistoryData, id?: string): SendOptions {
  return { ...jobOptions, singletonKey: job.userId, ...(id ? { id } : {}) };
}

/**
 * Queues a page of the user's import at its stored cursor, without an id: the stately queue folds it into a
 * page already waiting. Null when one was waiting. POST /api/import starts and resumes imports through this.
 */
export async function enqueueImportHistory(job: ImportHistoryData): Promise<string | null> {
  const parsed = data.parse(job);
  return getBoss().send(name, parsed, sendOptions(parsed));
}
