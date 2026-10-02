import type { WorkOptions } from "pg-boss";
import { getBoss, startBoss, stopBoss } from "./boss";
import * as syncGarmin from "./sync-garmin";

// Registers every queue and worker. Routes and the cron endpoint enqueue through the functions below.

export interface StartJobsOptions {
  /** Seconds between polls for new jobs; tests shorten it. */
  pollingIntervalSeconds?: number;
  /** The clock jobs read the user's current date from; tests pin it. */
  clock?: () => Date;
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
}

export async function stopJobs(): Promise<void> {
  await stopBoss();
}

/**
 * Queues a sync of the user's runs. The cron passes the user's local date and runs once per user and date;
 * app open and Sync now pass trigger "user" and always queue one, unless a sync is already queued for the
 * user, which then covers it. Null when nothing new was queued.
 */
export async function enqueueSyncGarmin(data: syncGarmin.SyncGarminData): Promise<string | null> {
  const job = syncGarmin.data.parse(data);
  return getBoss().send(syncGarmin.name, job, syncGarmin.sendOptions(job));
}
