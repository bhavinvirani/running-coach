import type { WorkOptions } from "pg-boss";
import * as bestEfforts from "./best-efforts";
import { getBoss, startBoss, stopBoss } from "./boss";
import * as importHistory from "./import-history";
import * as syncGarmin from "./sync-garmin";

// Registers every queue and worker. Routes and the cron endpoint enqueue through the functions below.

export interface StartJobsOptions {
  /** Seconds between polls for new jobs; tests shorten it. */
  pollingIntervalSeconds?: number;
  /** The clock jobs read the user's current date from; tests pin it. */
  clock?: () => Date;
  /** Items per history import page; tests use small pages so the fixture spans several. */
  historyPageSize?: number;
}

export async function startJobs(options: StartJobsOptions = {}): Promise<void> {
  const boss = await startBoss();
  const work: WorkOptions = {
    pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
    batchSize: 1,
  };

  await boss.createQueue(syncGarmin.name, syncGarmin.queue);
  await boss.work(syncGarmin.name, work, async ([job]) =>
    job ? syncGarmin.handle(boss, job, options.clock) : undefined,
  );

  await boss.createQueue(importHistory.name, importHistory.queue);
  // With metadata, so a page knows its last attempt (retryCount against retryLimit).
  await boss.work(importHistory.name, { ...work, includeMetadata: true }, async ([job]) =>
    job
      ? importHistory.handle(boss, job, {
          ...(options.historyPageSize === undefined ? {} : { pageSize: options.historyPageSize }),
        })
      : undefined,
  );

  await boss.createQueue(bestEfforts.name, bestEfforts.queue);
  await boss.work(bestEfforts.name, work, async ([job]) =>
    job ? bestEfforts.handle(boss, job) : undefined,
  );
}

export async function stopJobs(): Promise<void> {
  await stopBoss();
}

/**
 * Queues a sync of the user's runs. The cron passes the user's local date and runs once per user and date;
 * app open passes trigger "user" and always queues one, unless a sync is already queued for the user,
 * which then covers it. Null when nothing new was queued. Sync now does not queue (POST /api/sync).
 */
export async function enqueueSyncGarmin(data: syncGarmin.SyncGarminData): Promise<string | null> {
  const job = syncGarmin.data.parse(data);
  return getBoss().send(syncGarmin.name, job, syncGarmin.sendOptions(job));
}

/** Queues a page of the user's history import at its stored cursor (import-history-queue.ts). */
export { enqueueImportHistory } from "./import-history-queue";

/** Queues a batch of the user's best efforts unless one waits (best-efforts-queue.ts). */
export { enqueueBestEfforts } from "./best-efforts-queue";
