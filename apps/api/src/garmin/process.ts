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
  maxRestartDelayMs?: number;
}

interface Running {
  child: ChildProcess;
  exited: Promise<void>;
  hasExited: () => boolean;
}

const HEALTH_POLL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
// The service finishes in-flight requests for up to 10 s after SIGTERM.
const STOP_GRACE_MS = 12_000;
const START_ATTEMPTS = 3;
// A child that stayed up this long resets the restart backoff.
const STABLE_AFTER_MS = 60_000;

export class GarminServiceProcess {
  readonly url: string;
  readonly #options: Required<GarminProcessOptions>;
  #running: Running | undefined;
  #up = false;
  #supervising = false;
  #stopping = false;
  #restartAttempts = 0;
  #upSince = 0;
  #restartTimer: NodeJS.Timeout | undefined;

  constructor(options: GarminProcessOptions) {
    this.#options = { startTimeoutMs: 60_000, maxRestartDelayMs: 30_000, ...options };
    this.url = `http://127.0.0.1:${options.port}`;
  }

  /** The running child's pid, for logs and tests. */
  get pid(): number | undefined {
    return this.#running?.hasExited() === false ? this.#running.child.pid : undefined;
  }

  /** True while the child runs and answered /health; /health of the API reports 503 otherwise. */
  isUp(): boolean {
    return this.#up;
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
    this.#up = true;
    this.#upSince = Date.now();
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
    this.#options.log.warn({ code, signal }, "garmin service exited; restarting");
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    if (Date.now() - this.#upSince > STABLE_AFTER_MS) this.#restartAttempts = 0;
    const ceiling = Math.min(this.#options.maxRestartDelayMs, 1000 * 2 ** this.#restartAttempts);
    // Half fixed, half jitter: never instant, never in lockstep.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.#restartAttempts += 1;
    this.#restartTimer = setTimeout(() => void this.#restart(), delay);
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
