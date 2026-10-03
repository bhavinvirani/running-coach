import type { WorkOptions } from "pg-boss";
import * as analyzeRun from "./analyze-run";
import * as bestEfforts from "./best-efforts";
import { startBoss, stopBoss } from "./boss";
import * as importHistory from "./import-history";
import * as pushWorkouts from "./push-workouts";
import * as syncGarmin from "./sync-garmin";

// Registers every queue and worker. Services enqueue through the functions re-exported below.

export interface StartJobsOptions {
  /** Seconds between polls for new jobs; tests shorten it. */
  pollingIntervalSeconds?: number;
  /** The clock jobs read the user's current date from; tests pin it. */
  clock?: () => Date;
  /** Items per history import page; tests use small pages so the fixture spans several. */
  historyPageSize?: number;
  /** Seconds between chained best-efforts batches; tests shorten it. */
  bestEffortsGapSeconds?: number;
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

  await boss.createQueue(pushWorkouts.name, pushWorkouts.queue);
  await boss.work(pushWorkouts.name, work, async ([job]) =>
    job ? pushWorkouts.handle(boss, job, options.clock) : undefined,
  );

  await boss.createQueue(bestEfforts.name, bestEfforts.queue);
  await boss.work(bestEfforts.name, work, async ([job]) =>
    job
      ? bestEfforts.handle(boss, job, {
          ...(options.bestEffortsGapSeconds === undefined
            ? {}
            : { batchGapSeconds: options.bestEffortsGapSeconds }),
        })
      : undefined,
  );

  await boss.createQueue(analyzeRun.name, analyzeRun.queue);
  // With metadata, so the job knows its last attempt (retryCount against retryLimit).
  await boss.work(analyzeRun.name, { ...work, includeMetadata: true }, async ([job]) =>
    job ? analyzeRun.handle(boss, job) : undefined,
  );
}

export async function stopJobs(): Promise<void> {
  await stopBoss();
}

/**
 * Queues the daily cron's sync of a user for the fire's UTC date, once per user and date
 * (sync-garmin-queue.ts). App open and Sync now do not queue: POST /api/sync syncs in the request.
 */
export { enqueueSyncGarmin } from "./sync-garmin-queue";

/** Queues a page of the user's history import at its stored cursor (import-history-queue.ts). */
export { enqueueImportHistory } from "./import-history-queue";

/** Queues a batch of the user's best efforts unless one waits (best-efforts-queue.ts). */
export { enqueueBestEfforts } from "./best-efforts-queue";

/** Queues a push of the user's next seven days to Garmin unless one waits (push-workouts-queue.ts). */
export { enqueuePushWorkouts } from "./push-workouts-queue";

/** Queues the coach's card for one run unless a job for it waits (analyze-run-queue.ts). */
export { enqueueAnalyzeRun } from "./analyze-run-queue";
