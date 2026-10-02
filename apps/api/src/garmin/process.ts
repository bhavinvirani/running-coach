import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// The Garmin service runs as a child process of the API on 127.0.0.1 (SPEC Architecture). This module
// spawns it, waits for its /health, restarts it with backoff when it dies, and stops it on shutdown.
// It reads no configuration itself, so the test global setup starts the service the same way.

export interface ProcessLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface GarminProcessOptions {
  /** services/garmin: the working directory, with the uv-made venv in .venv. */
  serviceDir: string;
  port: number;
  secret: string;
  fixtures: boolean;
  logLevel: string;
  /** System variables (PATH, HOME, ...); the service's own variables are added on top. */
  baseEnv: Record<string, string>;
  log: ProcessLog;
  /** How long one start may take to answer /health; uvicorn imports curl_cffi slowly on 0.1 CPU. */
  startTimeoutMs?: number;
  /** Ceiling of the first restart delay; it doubles with every restart up to maxRestartDelayMs. */
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  /** A child that answered /health and then stayed up this long starts the restart backoff over. */
  stableAfterMs?: number;
  /** How long the child may be down before health() stops reporting ready. */
  downGraceMs?: number;
}

export type GarminProcessState = "starting" | "up" | "restarting" | "down" | "stopped";

interface Running {
  child: ChildProcess;
  exited: Promise<void>;
  hasExited: () => boolean;
  /** When it answered /health; unset for a child that never did. */
  healthySince?: number;
}

const HEALTH_POLL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
// The service finishes in-flight requests for up to 10 s after SIGTERM.
const STOP_GRACE_MS = 12_000;
const START_ATTEMPTS = 3;

export class GarminServiceProcess {
  readonly url: string;
  readonly #options: Required<GarminProcessOptions>;
  #running: Running | undefined;
  #up = false;
  #supervising = false;
  #stopping = false;
  #restartAttempts = 0;
  /** Since when the supervised child has been down; unset while it is up. */
  #downSince: number | undefined;
  #restartTimer: NodeJS.Timeout | undefined;

  constructor(options: GarminProcessOptions) {
    this.#options = {
      startTimeoutMs: 60_000,
      restartDelayMs: 1000,
      maxRestartDelayMs: 30_000,
      stableAfterMs: 60_000,
      // Render stops routing to an instance after 15 s of failed health checks and restarts it after 60 s.
      // One restart takes up to about a minute on 0.1 CPU, so a short one keeps the app reachable, and a
      // child still down after 3 minutes gets the whole instance restarted.
      downGraceMs: 3 * 60_000,
      ...options,
    };
    this.url = `http://127.0.0.1:${options.port}`;
  }

  /** The running child's pid, for logs and tests. */
  get pid(): number | undefined {
    return this.#running?.hasExited() === false ? this.#running.child.pid : undefined;
  }

  /** True while the child runs and answered /health. */
  isUp(): boolean {
    return this.#up;
  }

  /**
   * For the API's /health: ready while the child is up, and while it restarts within downGraceMs. Not
   * ready once it has been down longer, before the first start and after stop.
   */
  health(): { state: GarminProcessState; ready: boolean } {
    if (this.#stopping) return { state: "stopped", ready: false };
    if (this.#up) return { state: "up", ready: true };
    if (this.#downSince === undefined) return { state: "starting", ready: false };
    return Date.now() - this.#downSince < this.#options.downGraceMs
      ? { state: "restarting", ready: true }
      : { state: "down", ready: false };
  }

  /** Spawns the service and resolves once it answers /health; rejects (and kills it) when it does not. */
  async start(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#launch();
        break;
      } catch (err) {
        // An orphan of a killed API can hold the port for about a second until it notices.
        if (attempt >= START_ATTEMPTS) throw err;
        this.#options.log.warn({ err, attempt }, "garmin service did not start; trying again");
        await sleep(1000 * attempt);
      }
    }
    this.#supervising = true;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    const running = this.#running;
    if (!running || running.hasExited()) return;
    running.child.kill("SIGTERM");
    const killed = await Promise.race([
      running.exited.then(() => false),
      sleep(STOP_GRACE_MS, true, { ref: false }),
    ]);
    if (killed) {
      running.child.kill("SIGKILL");
      await running.exited;
    }
  }

  async #launch(): Promise<void> {
    const { serviceDir, port, secret, fixtures, logLevel, baseEnv } = this.#options;
    const child = spawn(
      path.join(serviceDir, ".venv/bin/uvicorn"),
      ["garmin_service.main:app", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: serviceDir,
        env: {
          ...baseEnv,
          GARMIN_SERVICE_SECRET: secret,
          GARMIN_FIXTURES: fixtures ? "1" : "0",
          LOG_LEVEL: logLevel,
          // The service exits when the API is gone, so a restart never meets an orphan on the port.
          GARMIN_PARENT_PID: String(process.pid),
          PYTHONUNBUFFERED: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        // Its JSON log lines go straight to the API's stdout.
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    let exited = false;
    const running: Running = {
      child,
      hasExited: () => exited,
      exited: new Promise((resolve) => {
        const done = (code: number | null, signal: NodeJS.Signals | null) => {
          if (exited) return;
          exited = true;
          this.#onExit(running, code, signal);
          resolve();
        };
        child.once("exit", done);
        // Spawn failures (a missing venv) emit only "error".
        child.once("error", (err) => {
          this.#options.log.error({ err }, "garmin service could not be started");
          done(null, null);
        });
      }),
    };
    this.#running = running;

    try {
      await this.#waitForHealth(running);
    } catch (err) {
      if (!running.hasExited()) {
        child.kill("SIGKILL");
        await running.exited;
      }
      throw err;
    }
    running.healthySince = Date.now();
    this.#up = true;
    this.#downSince = undefined;
  }

  async #waitForHealth(running: Running): Promise<void> {
    const deadline = Date.now() + this.#options.startTimeoutMs;
    while (Date.now() < deadline) {
      if (running.hasExited()) throw new Error("Garmin service exited before it answered /health");
      if (await this.#healthy()) return;
      await sleep(HEALTH_POLL_MS);
    }
    throw new Error(
      `Garmin service did not answer /health within ${this.#options.startTimeoutMs} ms`,
    );
  }

  async #healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/health`, {
        headers: { "x-garmin-secret": this.#options.secret },
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  #onExit(running: Running, code: number | null, signal: NodeJS.Signals | null): void {
    if (running !== this.#running) return;
    this.#up = false;
    if (!this.#supervising || this.#stopping) return;
    this.#downSince ??= Date.now();
    this.#scheduleRestart(running, code, signal);
  }

  #scheduleRestart(exited: Running, code: number | null, signal: NodeJS.Signals | null): void {
    // Decided by the child that just exited: one that never answered /health, or died soon after, keeps
    // the backoff growing, so a crash loop slows down however long an earlier child had been up.
    const { healthySince } = exited;
    if (healthySince !== undefined && Date.now() - healthySince > this.#options.stableAfterMs) {
      this.#restartAttempts = 0;
    }
    const { restartDelayMs, maxRestartDelayMs } = this.#options;
    const ceiling = Math.min(maxRestartDelayMs, restartDelayMs * 2 ** this.#restartAttempts);
    // Half fixed, half jitter: never instant, never in lockstep.
    const delayMs = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    this.#restartAttempts += 1;
    this.#options.log.warn(
      { code, signal, attempt: this.#restartAttempts, delayMs },
      "garmin service exited; restarting",
    );
    this.#restartTimer = setTimeout(() => void this.#restart(), delayMs);
    this.#restartTimer.unref();
  }

  async #restart(): Promise<void> {
    if (this.#stopping) return;
    try {
      await this.#launch();
      this.#options.log.info({ attempts: this.#restartAttempts }, "garmin service restarted");
    } catch (err) {
      // #launch killed the child; its exit already scheduled the next attempt.
      this.#options.log.error({ err }, "garmin service restart failed");
    }
  }
}
