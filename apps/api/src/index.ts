import type { Server } from "node:http";
import { createApp } from "./app";
import { closePools, pool } from "./db/client";
import { runMigrations } from "./db/migrate";
import { GarminServiceProcess } from "./garmin/process";
import { startJobs, stopJobs } from "./jobs";
import { config, inheritedEnv } from "./lib/config";
import { onShutdown, registerReadinessCheck, runShutdownHooks } from "./lib/lifecycle";
import { logger } from "./lib/logger";
import { paths } from "./lib/paths";
import { seedOwner } from "./services/owner";

// Boot order (api rule): config (validated on import) → migrations → owner → Garmin service child process
// → pg-boss and its workers → listen. The server listens last, so /health answers only once all are up;
// shutdown runs the same steps in reverse.

const log = logger.child({ module: "boot" });

async function seedOwnerFromConfig(): Promise<void> {
  if (!config.OWNER_EMAIL || !config.OWNER_PASSWORD) return;
  const result = await seedOwner({
    email: config.OWNER_EMAIL,
    password: config.OWNER_PASSWORD,
    name: config.OWNER_NAME,
  });
  log.info({ result }, "owner account checked");
}

async function startGarminService(): Promise<void> {
  const garmin = new GarminServiceProcess({
    serviceDir: paths.garminService,
    port: config.GARMIN_SERVICE_PORT,
    secret: config.GARMIN_SERVICE_SECRET,
    fixtures: config.GARMIN_FIXTURES,
    logLevel: config.LOG_LEVEL,
    baseEnv: inheritedEnv(),
    log: logger.child({ module: "garmin-process" }),
  });
  onShutdown("garmin service", () => garmin.stop());
  // After boot the child may die; it is restarted with backoff and /health says 503 meanwhile.
  registerReadinessCheck("garmin", () => garmin.isUp());
  await garmin.start();
  log.info(
    { port: config.GARMIN_SERVICE_PORT, fixtures: config.GARMIN_FIXTURES },
    "garmin service up",
  );
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createApp().listen(port, (error) => {
      if (error) reject(error);
      else resolve(server);
    });
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  // Render sends SIGKILL 30 s after SIGTERM; leave before that even if a connection hangs.
  setTimeout(() => process.exit(1), 25_000).unref();
  await runShutdownHooks((name, err) => log.error({ err, hook: name }, "shutdown step failed"));
  process.exit(0);
}

async function main(): Promise<void> {
  onShutdown("database", closePools);

  await runMigrations(pool);
  log.info("migrations applied");

  await seedOwnerFromConfig();

  await startGarminService();

  onShutdown("jobs", stopJobs);
  await startJobs();
  log.info("jobs started");

  const server = await listen(config.PORT);
  onShutdown("http", () => new Promise((resolve) => server.close(() => resolve())));
  log.info({ port: config.PORT }, "listening");
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err: unknown) => {
  log.fatal({ err }, "boot failed");
  void runShutdownHooks(() => undefined).finally(() => process.exit(1));
});
