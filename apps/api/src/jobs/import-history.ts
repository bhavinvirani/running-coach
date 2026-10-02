import { ErrorCode } from "@running-coach/shared";
import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import { DEFAULT_RETRY_AFTER_S } from "../garmin/client";
import { DomainError } from "../lib/errors";
import { logger, withRequestId } from "../lib/logger";
import {
  failImport,
  type ImportedPage,
  type ImportHistoryPageResult,
  importHistoryPage,
  pauseImport,
} from "../services/history-import";
import { data, jobOptions, name, pageJobId, sendOptions } from "./import-history-queue";

// One page of a user's full-history import per job (SPEC: History). POST /api/import queues the first page;
// each page queues the next until Garmin's list runs out. The queue's name, data and options live in
// import-history-queue.ts.

export { data, jobOptions, name, pageJobId, queue, sendOptions } from "./import-history-queue";
export type { ImportHistoryData } from "./import-history-queue";

export interface ImportHistoryHandleOptions {
  /** Items per Garmin call; tests use small pages so the fixture spans several. */
  pageSize?: number;
}

export type ImportHistoryOutput =
  | ImportHistoryPageResult
  /** A page that queued its successor; null when a page already waiting covers it. */
  | (ImportedPage & { nextJobId: string | null })
  | {
      status: "paused";
      retryAfterSeconds: number;
      resumeAt: Date;
      rescheduledJobIds: string[];
    }
  | {
      status: "failed";
      code: typeof ErrorCode.garminAuthExpired | typeof ErrorCode.garminNotConnected;
    };

/**
 * Runs the page at the stored cursor and queues the next one under an id keyed on the import and the new
 * offset, so the same page queueing it twice queues it once.
 *
 * A 429 pauses the import and defers its page exactly as sync defers itself: every waiting page of the user
 * moves to start after retryAfterSeconds, or one is queued for then, and the job completes, never as a failed
 * attempt. A deferred page finds the import paused and carries on. An expired or missing login fails the
 * import and completes: retrying cannot fix it, and every retry would be another failed Garmin login. Any
 * other error throws so pg-boss retries the page from the stored cursor; the last attempt fails the import
 * with the error's code first, so the runner sees why and can resume it.
 */
export async function handle(
  boss: PgBoss,
  job: Job<unknown> & Pick<JobWithMetadata, "retryLimit">,
  options: ImportHistoryHandleOptions = {},
): Promise<ImportHistoryOutput> {
  const input = data.parse(job.data);
  return withRequestId(`job-${job.id}`, async () => {
    const log = logger.child({
      module: "jobs",
      job: name,
      jobId: job.id,
      userId: input.userId,
      retryCount: job.retryCount,
    });
    try {
      const page = await importHistoryPage({
        userId: input.userId,
        signal: job.signal,
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      });
      if (page.status !== "continued") return page;
      const nextJobId = await boss.send(
        name,
        input,
        sendOptions(input, pageJobId(input.userId, page.startedAt, page.nextOffset)),
      );
      return { ...page, nextJobId };
    } catch (error) {
      if (error instanceof DomainError && error.code === ErrorCode.garminRateLimited) {
        const retryAfterSeconds = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_S;
        const resumeAt = await pauseImport(input.userId, retryAfterSeconds);
        const { jobs: rescheduledJobIds } = await boss.upsert(name, input, {
          ...jobOptions,
          singletonKey: input.userId,
          match: "all",
          startAfter: retryAfterSeconds,
        });
        log.warn({ retryAfterSeconds, rescheduledJobIds }, "garmin rate limited; import paused");
        return { status: "paused", retryAfterSeconds, resumeAt, rescheduledJobIds };
      }
      if (
        error instanceof DomainError &&
        (error.code === ErrorCode.garminAuthExpired || error.code === ErrorCode.garminNotConnected)
      ) {
        await failImport(input.userId, error.code);
        log.warn({ code: error.code }, "history import failed");
        return { status: "failed", code: error.code };
      }
      if (job.retryCount >= job.retryLimit) {
        const code = error instanceof DomainError ? error.code : ErrorCode.internal;
        await failImport(input.userId, code);
        log.warn({ code }, "history import failed after its last attempt");
      }
      throw error;
    }
  });
}
