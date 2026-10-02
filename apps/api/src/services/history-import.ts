import {
  ErrorCode,
  errorCodeSchema,
  type ImportProgress,
  type ImportStatus,
} from "@running-coach/shared";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { activity, type ImportProgressRow, importProgress } from "../db/schema";
import { garminClient } from "../garmin/client";
import { hasPendingJob } from "../jobs/boss";
import * as importQueue from "../jobs/import-history-queue";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";
import { queueBestEfforts } from "./best-efforts";
import { openGarminAccount, recordGarminSuccess, requireGarminConnection } from "./garmin-account";
import { upsertActivities } from "./garmin-sync";

// The full-history import (SPEC: History): Garmin's activity list newest first, one job per page by offset,
// each page committing its runs and its cursor together, so a killed import resumes where it stopped. The
// state lives in import_progress; POST /api/import starts or resumes it, the import-history job runs pages.

const log = logger.child({ module: "history-import" });

export const HISTORY_PAGE_SIZE = 100;
/**
 * Each page re-reads the previous page's last runs: a run deleted on Garmin mid-import shifts every older
 * one up by one offset, and up to this many deletions can then not push a run past the cursor unread. The
 * upsert makes the re-read free.
 */
export const HISTORY_PAGE_OVERLAP = 5;

/** Whether pg-boss holds a page of the user's import that it can still run. */
function pagePending(userId: string): Promise<boolean> {
  return hasPendingJob(importQueue.name, userId);
}

/**
 * The status the runner sees. A running or paused import with no page job pg-boss can still run lost its
 * chain (a killed process past its last attempt, a lost send) and shows as stalled; while a page waits,
 * retries or runs, it shows as stored. pg-boss is asked only for those two statuses.
 */
async function derivedStatus(row: ImportProgressRow): Promise<ImportStatus> {
  if (row.status !== "running" && row.status !== "paused") return row.status;
  return (await pagePending(row.userId)) ? row.status : "stalled";
}

async function readProgress(userId: string): Promise<ImportProgressRow | undefined> {
  const [row] = await db.select().from(importProgress).where(eq(importProgress.userId, userId));
  return row;
}

/** GET /api/import: where the import stands, with every run stored for the user, imported or synced. */
export async function getImportProgress(userId: string): Promise<ImportProgress> {
  const [row, [stored]] = await Promise.all([
    readProgress(userId),
    db.select({ runs: count() }).from(activity).where(eq(activity.userId, userId)),
  ]);
  const runsStored = stored?.runs ?? 0;
  if (!row) {
    return {
      status: "not_started",
      runsStored,
      oldestDate: null,
      startedAt: null,
      finishedAt: null,
      resumeAt: null,
      errorCode: null,
    };
  }
  const errorCode = errorCodeSchema.safeParse(row.lastError);
  return {
    status: await derivedStatus(row),
    runsStored,
    oldestDate: row.cursorDate,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    resumeAt: row.resumeAt?.toISOString() ?? null,
    // Codes come from this app only; anything else would be a bug, shown as internal rather than a 500.
    errorCode:
      row.lastError === null ? null : errorCode.success ? errorCode.data : ErrorCode.internal,
  };
}

/**
 * POST /api/import. Refuses without a usable Garmin login (409, as sync). Starts a fresh import when none
 * ran or the last one finished, resumes a failed or stalled one from its cursor, and changes nothing while
 * a running or paused one still has a page job pg-boss can run: a second page beside a retrying one would
 * call Garmin during the outage it waits out. The decision takes the row's lock (or inserts it), so two
 * concurrent POSTs start one import. The page is queued after the commit and without an id: the stately
 * queue folds it into a page already waiting, and if the process dies before the send, the import shows as
 * stalled and the next POST queues it again.
 */
export async function startImport(userId: string): Promise<ImportProgress> {
  await requireGarminConnection(userId);

  const queuePage = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(importProgress)
      .values({ userId, status: "running", startedAt: sql`now()` })
      .onConflictDoNothing({ target: importProgress.userId })
      .returning({ id: importProgress.id });
    if (inserted) return true;

    const [row] = await tx
      .select()
      .from(importProgress)
      .where(eq(importProgress.userId, userId))
      .for("update");
    if (!row) throw new Error("import_progress row vanished under its lock");
    const status = await derivedStatus(row);
    const ofUser = eq(importProgress.userId, userId);
    if (status === "done") {
      await tx
        .update(importProgress)
        .set({
          status: "running",
          nextOffset: 0,
          cursorDate: null,
          lastError: null,
          resumeAt: null,
          startedAt: sql`now()`,
          finishedAt: null,
          updatedAt: sql`now()`,
        })
        .where(ofUser);
      return true;
    }
    if (status === "failed" || status === "stalled") {
      await tx
        .update(importProgress)
        .set({ status: "running", lastError: null, resumeAt: null, updatedAt: sql`now()` })
        .where(ofUser);
      return true;
    }
    return false;
  });

  if (queuePage) {
    await importQueue.enqueueImportHistory({ userId });
    log.info({ userId }, "history import queued");
  }
  return getImportProgress(userId);
}

export interface ImportHistoryPageInput {
  userId: string;
  /** Items per Garmin call; tests use small pages so the fixture spans several. */
  pageSize?: number;
  /** Aborts before the Garmin call, when the worker stops. */
  signal?: AbortSignal;
}

export interface ImportedPage {
  status: "continued" | "done";
  /** The import's start, which keys the successor page's job id. */
  startedAt: Date;
  start: number;
  nextOffset: number;
  /** Items Garmin listed in the page, runs or not. */
  listed: number;
  /** Rows inserted or changed. */
  written: number;
}

export type ImportHistoryPageResult = { status: "skipped" } | ImportedPage;

/**
 * Imports one page at the stored cursor, inside the per-user lock so it never overlaps a sync or another
 * page. Skips (writes nothing, calls no one) when no import is running or paused. Throws as sync does for a
 * missing or expired login and during the hour after a 429; a paused import that passes those gates is
 * running again before Garmin is called. Rethrows a failed Garmin call after recording it on the
 * connection; the job decides what each error means for the import. On success the runs, the cursor and
 * the connection's ok status commit in one transaction. Garmin's short page ends the import. An imported
 * page then queues the user's best efforts when runs are pending, outside the lock the batch also takes.
 */
export async function importHistoryPage({
  userId,
  pageSize = HISTORY_PAGE_SIZE,
  signal,
}: ImportHistoryPageInput): Promise<ImportHistoryPageResult> {
  // The cursor must move forward on every full page, or the chain would read the same page forever.
  if (pageSize <= HISTORY_PAGE_OVERLAP) {
    throw new RangeError(`pageSize must exceed the overlap of ${HISTORY_PAGE_OVERLAP}`);
  }

  const imported = await withUserLock(userId, async (): Promise<ImportHistoryPageResult> => {
    const progress = await readProgress(userId);
    if (!progress || progress.status === "done" || progress.status === "failed") {
      return { status: "skipped" } as const;
    }
    signal?.throwIfAborted();

    const account = await openGarminAccount(userId);
    if (progress.status === "paused") {
      // The deferred page is past the 429's hour and about to call Garmin: from here a transient failure
      // leaves the import running with its retry pending, not paused with a resume time in the past.
      await db
        .update(importProgress)
        .set({ status: "running", resumeAt: null, lastError: null, updatedAt: sql`now()` })
        .where(and(eq(importProgress.userId, userId), eq(importProgress.status, "paused")));
    }
    const start = progress.nextOffset;
    const page = await account.call((tokenBundle, options) =>
      garminClient.history({ tokenBundle, start, limit: pageSize }, options),
    );

    const done = page.listed < pageSize;
    const nextOffset = done ? start + page.listed : start + page.listed - HISTORY_PAGE_OVERLAP;
    const oldestDate = page.activities.reduce<string | null>((oldest, run) => {
      const date = run.startLocal.slice(0, "YYYY-MM-DD".length);
      return oldest === null || date < oldest ? date : oldest;
    }, null);

    const written = await db.transaction(async (tx) => {
      const rows = await upsertActivities(userId, page.activities, tx);
      await tx
        .update(importProgress)
        .set({
          status: done ? "done" : "running",
          nextOffset,
          // least() ignores the null of a first page.
          ...(oldestDate
            ? { cursorDate: sql`least(${importProgress.cursorDate}, ${oldestDate}::date)` }
            : {}),
          finishedAt: done ? sql`now()` : null,
          lastError: null,
          resumeAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(importProgress.userId, userId));
      // As a sync chunk does, but the history import never moves last_sync_at: that is the sync's cursor.
      await recordGarminSuccess(tx, userId);
      return rows;
    });

    const result = {
      status: done ? "done" : "continued",
      startedAt: progress.startedAt,
      start,
      nextOffset,
      listed: page.listed,
      written,
    } as const;
    log.info({ userId, ...result }, "history page imported");
    return result;
  });
  if (imported.status !== "skipped") await queueBestEfforts(userId);
  return imported;
}

const unfinished = inArray(importProgress.status, ["running", "paused"]);

/**
 * After a Garmin 429: the import waits until resumeAt, when its deferred page runs. Returns that time. Only
 * a running or paused import pauses; a page never reaches Garmin for any other.
 */
export async function pauseImport(userId: string, retryAfterSeconds: number): Promise<Date> {
  const resumeAt = new Date(Date.now() + retryAfterSeconds * 1000);
  await db
    .update(importProgress)
    .set({
      status: "paused",
      resumeAt,
      lastError: ErrorCode.garminRateLimited,
      updatedAt: sql`now()`,
    })
    .where(and(eq(importProgress.userId, userId), unfinished));
  return resumeAt;
}

/** Ends the import with the code of what stopped it; POST /api/import resumes it from its cursor. */
export async function failImport(userId: string, code: ErrorCode): Promise<void> {
  await db
    .update(importProgress)
    .set({ status: "failed", lastError: code, resumeAt: null, updatedAt: sql`now()` })
    .where(and(eq(importProgress.userId, userId), unfinished));
}
