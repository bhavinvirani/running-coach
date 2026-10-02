import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { config, inheritedEnv } from "../../src/lib/config";
import { type GarminProcessOptions, GarminServiceProcess } from "../../src/garmin/process";
import { paths } from "../../src/lib/paths";

// A second service process beside the run's shared one, to kill and watch come back. The backoff and
// grace tests use a stand-in for uvicorn that answers /health, or exits at once while a "crash" file
// sits in its directory.

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
let service: GarminServiceProcess | undefined;
let fakeDir: string | undefined;

const FAKE_UVICORN = `
const fs = require("node:fs");
const http = require("node:http");
if (fs.existsSync("crash")) process.exit(1);
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http
  .createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}'))
  .listen(port, "127.0.0.1");
`;

/** A service directory whose .venv/bin/uvicorn is the stand-in. */
async function fakeServiceDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "garmin-process-"));
  await writeFile(path.join(dir, "fake-uvicorn.cjs"), FAKE_UVICORN);
  const bin = path.join(dir, ".venv", "bin");
  await mkdir(bin, { recursive: true });
  const uvicorn = path.join(bin, "uvicorn");
  await writeFile(
    uvicorn,
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "fake-uvicorn.cjs")}" "$@"\n`,
  );
  await chmod(uvicorn, 0o755);
  fakeDir = dir;
  return dir;
}

/** Records the restart log lines: the attempt number and the delay before it. */
function restartLog() {
  const restarts: { attempt: number; delayMs: number }[] = [];
  const log = {
    ...quiet,
    warn: (obj: object, msg: string) => {
      if (msg.includes("restarting")) restarts.push(obj as { attempt: number; delayMs: number });
    },
  };
  return { restarts, log };
}

async function startFake(
  dir: string,
  options: Partial<GarminProcessOptions>,
): Promise<GarminServiceProcess> {
  service = new GarminServiceProcess({
    serviceDir: dir,
    port: await freePort(),
    secret: "unused",
    fixtures: true,
    logLevel: "silent",
    baseEnv: inheritedEnv(),
    log: quiet,
    ...options,
  });
  await service.start();
  return service;
}

function killChild(garmin: GarminServiceProcess): void {
  const { pid } = garmin;
  if (!pid) throw new Error("no child running");
  process.kill(pid, "SIGKILL");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(50);
  }
}

async function startService(): Promise<GarminServiceProcess> {
  service = new GarminServiceProcess({
    serviceDir: paths.garminService,
    port: await freePort(),
    secret: config.GARMIN_SERVICE_SECRET,
    fixtures: true,
    logLevel: "silent",
    baseEnv: inheritedEnv(),
    log: quiet,
    maxRestartDelayMs: 1000,
  });
  await service.start();
  return service;
}

afterEach(async () => {
  await service?.stop();
  service = undefined;
  if (fakeDir) await rm(fakeDir, { recursive: true, force: true });
  fakeDir = undefined;
});

describe("GarminServiceProcess", () => {
  it("starts the service and reports up once /health answers with the secret", async () => {
    const garmin = await startService();

    expect(garmin.isUp()).toBe(true);
    const response = await fetch(`${garmin.url}/health`, {
      headers: { "x-garmin-secret": config.GARMIN_SERVICE_SECRET },
    });
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("reports down when the child dies, then restarts it", async () => {
    const garmin = await startService();
    const firstPid = garmin.pid;
    if (!firstPid) throw new Error("no pid");

    process.kill(firstPid, "SIGKILL");
    await until(() => !garmin.isUp());
    await until(() => garmin.isUp(), 20_000);

    expect(garmin.pid).toBeDefined();
    expect(garmin.pid).not.toBe(firstPid);
  });

  it("stops the child on shutdown and does not restart it", async () => {
    const garmin = await startService();
    const pid = garmin.pid;

    await garmin.stop();
    await sleep(1500);

    expect(garmin.isUp()).toBe(false);
    expect(garmin.health()).toEqual({ state: "stopped", ready: false });
    expect(garmin.pid).toBeUndefined();
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
  });

  it("keeps backing off while relaunches die before /health, however long the last healthy child ran (crash loop)", async () => {
    const dir = await fakeServiceDir();
    const { restarts, log } = restartLog();
    const garmin = await startFake(dir, {
      log,
      restartDelayMs: 20,
      maxRestartDelayMs: 10_000,
      stableAfterMs: 100,
    });
    // Up longer than stableAfterMs, then every relaunch exits before it answers /health.
    await sleep(150);
    await writeFile(path.join(dir, "crash"), "");
    killChild(garmin);

    await until(() => restarts.length >= 5);

    expect(restarts.slice(0, 5).map((restart) => restart.attempt)).toEqual([1, 2, 3, 4, 5]);
    // Each delay is at least half its ceiling, which doubles from 20 ms.
    restarts.slice(0, 5).forEach((restart, index) => {
      expect(restart.delayMs).toBeGreaterThanOrEqual(10 * 2 ** index);
    });
  });

  it("starts the backoff over only once a restarted child stayed up past stableAfterMs", async () => {
    const dir = await fakeServiceDir();
    const { restarts, log } = restartLog();
    const garmin = await startFake(dir, {
      log,
      restartDelayMs: 20,
      maxRestartDelayMs: 200,
      stableAfterMs: 300,
    });

    // Dies right after it came back: the backoff keeps growing.
    killChild(garmin);
    await until(() => restarts.length === 1 && garmin.isUp());
    killChild(garmin);
    await until(() => restarts.length === 2 && garmin.isUp());
    // Stays up past stableAfterMs before it dies: the backoff starts over.
    await sleep(400);
    killChild(garmin);
    await until(() => restarts.length === 3);

    expect(restarts.map((restart) => restart.attempt)).toEqual([1, 2, 1]);
  });

  it("stays ready as restarting while the child is down within the grace period, then reports down and not ready", async () => {
    const dir = await fakeServiceDir();
    const garmin = await startFake(dir, {
      restartDelayMs: 20,
      maxRestartDelayMs: 50,
      downGraceMs: 500,
    });
    expect(garmin.health()).toEqual({ state: "up", ready: true });

    await writeFile(path.join(dir, "crash"), "");
    const downAt = Date.now();
    killChild(garmin);
    await until(() => !garmin.isUp());

    expect(garmin.health()).toEqual({ state: "restarting", ready: true });
    await until(() => garmin.health().state === "down");
    expect(Date.now() - downAt).toBeGreaterThanOrEqual(450);
    expect(garmin.health()).toEqual({ state: "down", ready: false });

    // Back up: ready again, and a later outage gets the whole grace period anew.
    await rm(path.join(dir, "crash"));
    await until(() => garmin.isUp());
    expect(garmin.health()).toEqual({ state: "up", ready: true });
    await writeFile(path.join(dir, "crash"), "");
    killChild(garmin);
    await until(() => !garmin.isUp());
    expect(garmin.health()).toEqual({ state: "restarting", ready: true });
  });

  it("rejects start when the service cannot run", async () => {
    service = new GarminServiceProcess({
      serviceDir: "/nonexistent/garmin",
      port: await freePort(),
      secret: config.GARMIN_SERVICE_SECRET,
      fixtures: true,
      logLevel: "silent",
      baseEnv: inheritedEnv(),
      log: quiet,
    });

    await expect(service.start()).rejects.toThrow(/exited/);
    expect(service.isUp()).toBe(false);
  });
});
