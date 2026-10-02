import { createHash } from "node:crypto";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import { config } from "../lib/config";
import { logger } from "../lib/logger";

// pg-boss 12 on the app database, in its own "pgboss" schema, started and stopped by the boot sequence.

const log = logger.child({ module: "jobs" });

let boss: PgBoss | undefined;

export async function startBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const instance = new PgBoss({
    connectionString: config.DATABASE_URL,
    // Its own small pool beside the app's five: 512 MB box, Neon Free's connection limit.
    max: 3,
    application_name: "running-coach-jobs",
    // Recurring work comes from the GitHub Actions cron (SPEC), not pg-boss schedules.
    schedule: false,
  });
  // Without a listener an "error" event would crash the process.
  instance.on("error", (err) => log.error({ err }, "pg-boss error"));
  instance.on("warning", (warning) => log.warn({ warning }, "pg-boss warning"));
  await instance.start();
  boss = instance;
  return instance;
}

export function getBoss(): PgBoss {
  if (!boss) throw new Error("pg-boss is not started");
  return boss;
}

/** Waits for active jobs to finish (bounded), then closes pg-boss's pool. */
export async function stopBoss(): Promise<void> {
  const instance = boss;
  boss = undefined;
  await instance?.stop({ graceful: true, timeout: 15_000 });
}

// A job in one of these states is still pg-boss's to run: waiting or deferred, between retries, or running
// (a killed one stays active until its expiry, then retries or fails).
const PENDING_JOB_STATES: ReadonlySet<JobWithMetadata["state"]> = new Set([
  "created",
  "retry",
  "active",
]);

/**
 * A waiting job due within this many seconds waits its turn; one due later is held back (a 429's hour). A
 * chained successor's short gap (best-efforts' 30 s) is a turn, not a hold.
 */
export const HELD_BACK_AFTER_S = 60;

export interface PendingJob {
  /** Some pending job of the key waits out a retry's backoff, or is not due for HELD_BACK_AFTER_S. */
  heldBack: boolean;
}

/**
 * The jobs of the queue under this singleton key that pg-boss can still run, folded into one answer: null
 * when there is none, else whether they are held back rather than waiting their turn or running.
 */
export async function findPendingJob(name: string, key: string): Promise<PendingJob | null> {
  // Without `queued`, findJobs returns every state; `queued` alone would leave out the active job.
  const jobs = (await getBoss().findJobs(name, { key })).filter((job) =>
    PENDING_JOB_STATES.has(job.state),
  );
  if (jobs.length === 0) return null;
  const heldAfter = Date.now() + HELD_BACK_AFTER_S * 1000;
  return {
    heldBack: jobs.some(
      (job) =>
        job.state === "retry" || (job.state === "created" && job.startAfter.getTime() > heldAfter),
    ),
  };
}

/** Whether pg-boss holds a job of the queue under this singleton key that it can still run. */
export async function hasPendingJob(name: string, key: string): Promise<boolean> {
  return (await findPendingJob(name, key)) !== null;
}

/**
 * Whether a job of the queue under this singleton key waits to start: due, deferred, or between retries.
 * A running job is left out: the stately queue keeps one waiting job beside it.
 */
export async function hasWaitingJob(name: string, key: string): Promise<boolean> {
  // `queued` is pg-boss's created and retry states.
  return (await getBoss().findJobs(name, { key, queued: true })).length > 0;
}

// A fixed namespace for this app's job ids.
const JOB_ID_NAMESPACE = Buffer.from("4b1e7c52a9d04f3e8c6b2d7f19a0e365", "hex");

/**
 * A deterministic job id from a key. pg-boss ids are UUIDs and a send whose id already exists (queued,
 * active, or kept after completion) is a no-op, so the same key enqueued twice runs once. Name-based
 * UUID, version 5 layout (RFC 9562): SHA-1 of namespace and key.
 */
export function deterministicJobId(key: string): string {
  const bytes = createHash("sha1").update(JOB_ID_NAMESPACE).update(key, "utf8").digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
