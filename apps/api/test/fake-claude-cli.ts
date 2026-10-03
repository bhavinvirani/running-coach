import path from "node:path";
import { parseArgs } from "node:util";
import { startFakeClaude } from "./fake-claude";

// pnpm fake:claude [--port 8776]: the fake Claude over test/fixtures/claude as its own process, for the
// Playwright config to start beside the e2e API (CLAUDE_BASE_URL=http://127.0.0.1:<port>). Fake keys
// only; it never reaches Anthropic.

const { values } = parseArgs({ options: { port: { type: "string", default: "8776" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`--port must be a port number, got "${values.port}".`);
  process.exit(1);
}

const fake = await startFakeClaude(path.join(import.meta.dirname, "fixtures/claude"), port);
console.warn(`fake Claude listening on ${fake.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
