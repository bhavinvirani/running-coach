import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { config, inheritedEnv } from "../../src/lib/config";
import { GarminServiceProcess } from "../../src/garmin/process";
import { paths } from "../../src/lib/paths";

// A second service process beside the run's shared one, to kill and watch come back.

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
let service: GarminServiceProcess | undefined;

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
    expect(garmin.pid).toBeUndefined();
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
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
