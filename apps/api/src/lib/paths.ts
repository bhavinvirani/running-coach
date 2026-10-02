import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Source (tsx, Vitest) and the tsup bundle in dist/ sit at different depths, so paths are resolved from the
// package root, found by walking up to the package.json named @running-coach/api.

function findApiRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
      if (name === "@running-coach/api") return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`No @running-coach/api package.json above ${start}`);
    }
  }
}

const apiRoot = findApiRoot(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(apiRoot, "../..");

export const paths = {
  apiRoot,
  repoRoot,
  migrations: path.join(apiRoot, "src/db/migrations"),
  prompts: path.join(apiRoot, "src/coach/prompts"),
  webDist: path.join(repoRoot, "apps/web/dist"),
  garminService: path.join(repoRoot, "services/garmin"),
} as const;
