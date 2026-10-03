import { listenHost, loadConfig } from "./config";
import { createLogger } from "./logger";
import { createRunner } from "./run";
import { createCoachServer } from "./server";

// The coach service: config (exits on an invalid value) → listen. SIGTERM (a Render deploy or sleep) stops
// listening, aborts the running Claude Code process and exits once it is gone.

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const runner = createRunner({ config, logger });
const server = createCoachServer({ config, logger, runner });

const host = listenHost(config.NODE_ENV);
server.listen(config.PORT, host, () => {
  logger.info(
    {
      host,
      port: config.PORT,
      credential: config.CLAUDE_CODE_OAUTH_TOKEN === undefined ? "local_login" : "plan_token",
      executable: config.CLAUDE_CODE_EXECUTABLE === undefined ? "bundled" : "configured",
    },
    "coach service listening",
  );
});

let stopping = false;
async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "coach service stopping");
  server.close();
  await runner.shutdown();
  server.closeAllConnections();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void shutdown(signal));
}
