// `pnpm test:screens [--update] [playwright test options]`: runs the screens project against the Chromium
// inside the official Playwright image, so host fonts never reach a baseline. The image always runs as
// linux/amd64, what CI's runners are: CI's render is the reference, and an arm64 laptop emulates it rather
// than rendering its own pixels. Starts a run-server container on a free port, waits for it, runs the tests,
// and always removes the container.
// Runs on Node's type stripping: no relative imports, no TypeScript-only runtime syntax.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";

const webDir = path.resolve(import.meta.dirname, "..");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));

const testPackageJson = requireFromWeb.resolve("@playwright/test/package.json");
const playwrightCli = requireFromWeb.resolve("@playwright/test/cli");
// playwright-core is a dependency of a dependency; resolve it the way @playwright/test does.
const playwrightPackageJson = createRequire(testPackageJson).resolve("playwright/package.json");
const coreDir = path.dirname(
  createRequire(playwrightPackageJson).resolve("playwright-core/package.json"),
);

// The image's browsers must be the build the installed Playwright expects, so its tag follows the lockfile.
const { version } = JSON.parse(readFileSync(testPackageJson, "utf8")) as { version: string };
const image = `mcr.microsoft.com/playwright:v${version}-noble`;
const PLATFORM = "linux/amd64";

const READY_TIMEOUT_MS = 60_000;

let container: string | undefined;
let child: ChildProcess | undefined;

function docker(args: string[], output: "capture" | "show" = "capture") {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: output === "show" ? "inherit" : "pipe",
  });
  if (result.error) throw new Error(`Could not run docker: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function removeContainer(): void {
  if (container) docker(["rm", "--force", container]);
  container = undefined;
}

// Ctrl-C reaches the Playwright child through the terminal. SIGTERM is passed on as SIGINT, the one signal
// Playwright handles by stopping its web server; on SIGTERM it would exit and orphan the API. This process
// then waits for the child to exit, so the finally below removes the container. Before the child starts, a
// signal removes the container at once.
process.on("SIGINT", () => {
  if (child) return;
  removeContainer();
  process.exit(130);
});
process.on("SIGTERM", () => {
  if (child) {
    child.kill("SIGINT");
    return;
  }
  removeContainer();
  process.exit(143);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("No port assigned"));
      });
    });
  });
}

function isRunning(name: string): boolean {
  const result = docker(["inspect", "--format", "{{.State.Running}}", name]);
  return result.status === 0 && result.stdout.trim() === "true";
}

/** run-server answers plain HTTP with 200 "Running" once its WebSocket endpoint is up. */
async function waitForServer(name: string, port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet: Docker accepts the connection before the server inside does.
    }
    if (!isRunning(name)) {
      const logs = docker(["logs", name]);
      throw new Error(`The Playwright container exited:\n${logs.stdout}${logs.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The Playwright container did not answer within ${READY_TIMEOUT_MS / 1000} s`);
}

function runScreens(port: number, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [playwrightCli, "test", "--project", "screens", ...args], {
      cwd: webDir,
      stdio: "inherit",
      env: { ...process.env, PW_SCREENS_WS_ENDPOINT: `ws://127.0.0.1:${port}/` },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main(): Promise<number> {
  const args = process.argv
    .slice(2)
    // "all", not Playwright's "changed": a change under the comparison threshold (a text color one step
    // lighter) would otherwise leave the old pixels in the baseline.
    .map((arg) => (arg === "--update" ? "--update-snapshots=all" : arg));

  // Pull in the foreground the first time, so a 2 GB download shows progress instead of a silent wait. The
  // inspect fails when only another platform's build is present (for example arm64 from an earlier run).
  if (docker(["image", "inspect", "--platform", PLATFORM, image]).status !== 0) {
    if (docker(["pull", "--platform", PLATFORM, image], "show").status !== 0) {
      throw new Error(`Could not pull ${image} for ${PLATFORM}`);
    }
  }

  const port = await freePort();
  const name = `running-coach-screens-${port}`;
  container = name;
  const started = docker([
    "run",
    "--platform",
    PLATFORM,
    "--detach",
    "--init",
    // Chromium needs more shared memory than Docker's 64 MB default.
    "--ipc=host",
    "--name",
    name,
    "--publish",
    `127.0.0.1:${port}:3000`,
    "--user",
    "pwuser",
    "--workdir",
    "/home/pwuser",
    // The installed playwright-core is pure JavaScript: mounting it needs no network and pins the version.
    "--volume",
    `${coreDir}:/opt/playwright-core:ro`,
    image,
    "node",
    "/opt/playwright-core/cli.js",
    "run-server",
    "--port",
    "3000",
    "--host",
    "0.0.0.0",
  ]);

  try {
    if (started.status !== 0) throw new Error(`Could not start ${image}:\n${started.stderr}`);
    await waitForServer(name, port);
    return await runScreens(port, args);
  } finally {
    removeContainer();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
