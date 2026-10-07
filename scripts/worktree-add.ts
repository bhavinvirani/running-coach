// `pnpm worktree:add <lane>`: makes the sibling folder one parallel session works in (#46), ../running-coach-<lane>,
// a git worktree detached at a freshly fetched origin/main with its dependencies installed. It also writes the
// folder's e2e slot, so its ports and e2e database never collide with another folder's run, and links the
// git-ignored reference/ from the main folder. It never creates, copies or reads .env: the commands that need
// the owner's secrets stay in the main folder. Fails fast and deletes nothing; a half-made folder is left for
// the owner to remove.
// Runs on Node's type stripping: no relative imports, no TypeScript-only runtime syntax.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const LANE = /^[a-z][a-z0-9-]*$/;
// Slot 0 is the main folder's; slot N moves every e2e port up by 10·N.
const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const SLOT_FILE = ".e2e-slot";

const here = path.resolve(import.meta.dirname, "..");
// Set once the worktree exists: from then on a failure says how to remove it.
let startOver = "";

function fail(reason: string): never {
  console.error(reason);
  if (startOver) console.error(`To start over: ${startOver}`);
  process.exit(1);
}

function run(command: string, args: string[], cwd: string, output: "capture" | "show"): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: output === "show" ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  const line = `${command} ${args.join(" ")}`;
  if (result.error) fail(`Could not run ${line}: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().split("\n")[0];
    fail(`${line} failed${stderr ? `: ${stderr}` : ` in ${cwd}`}`);
  }
  return (result.stdout ?? "").trim();
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** The slot another worktree holds; a missing, unreadable or malformed file holds none. */
function heldSlot(folder: string): number | undefined {
  try {
    const value = readFileSync(path.join(folder, SLOT_FILE), "utf8").trim();
    return /^[0-9]$/.test(value) ? Number(value) : undefined;
  } catch {
    return undefined;
  }
}

const lane = process.argv[2];
if (process.argv.length !== 3 || !lane || !LANE.test(lane) || lane === "main") {
  fail(
    "Usage: pnpm worktree:add <lane>  (lowercase letters, digits and dashes, starting with a letter; " +
      "not main, which is the main folder itself)",
  );
}

// The common git dir is <main>/.git from the main folder and from every linked worktree.
const main = path.dirname(
  run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], here, "capture"),
);
const target = path.join(path.dirname(main), `${path.basename(main)}-${lane}`);
if (lstatSync(target, { throwIfNoEntry: false })) fail(`${target} already exists`);

const worktrees = run("git", ["worktree", "list", "--porcelain"], main, "capture")
  .split("\n")
  .filter((line) => line.startsWith("worktree "))
  .map((line) => line.slice("worktree ".length))
  .filter((folder) => !samePath(folder, main));
const taken = new Set(worktrees.map(heldSlot));
const slot = SLOTS.find((candidate) => !taken.has(candidate));
if (slot === undefined) {
  fail("All e2e slots 1-9 are held by other worktrees; remove one with git worktree remove first");
}

// A stale origin/main would start the lane behind lanes that already merged.
run("git", ["fetch", "origin"], main, "show");
run("git", ["worktree", "add", "--detach", target, "origin/main"], main, "show");
startOver = `git worktree remove --force ${target}`;

writeFileSync(path.join(target, SLOT_FILE), `${slot}\n`);
const reference = path.join(main, "reference");
if (lstatSync(reference, { throwIfNoEntry: false })) {
  symlinkSync(reference, path.join(target, "reference"), "dir");
}

run("pnpm", ["install", "--frozen-lockfile"], target, "show");
run("uv", ["sync", "--frozen"], path.join(target, "services", "garmin"), "show");

const port = (base: number) => base + 10 * slot;
console.log(`
${target} is ready, detached at origin/main, e2e slot ${slot}:
  app ${port(4173)}, Garmin service ${port(8775)}, fake Claude ${port(8776)}, coach service ${port(8778)}, database running_coach_e2e_${slot}

Runs here: pnpm check, pnpm test:e2e, pnpm test:screens, pnpm py:check, pnpm build.

Main folder only (${main}): these read the owner's .env, which a worktree never gets,
and Postgres is one shared container, started there:
  pnpm dev, pnpm coach:dev, pnpm db:migrate, pnpm seed:owner, pnpm garmin:connect,
  pnpm --filter @running-coach/api coach:eval, docker compose up -d --wait --no-recreate postgres

Next: cd ${target}, start Claude Code, /slice N`);
