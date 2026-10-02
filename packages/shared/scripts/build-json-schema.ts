// Writes one JSON Schema file per exported zod schema into src/json-schema/ (committed).
// `--check` writes nothing and exits 1 when the committed files differ: the contract drift check.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as shared from "../src/index";

const outDir = join(import.meta.dirname, "../src/json-schema");
const check = process.argv.includes("--check");

function kebab(name: string): string {
  return name
    .replace(/Schema$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

const expected = new Map<string, string>();
for (const [name, value] of Object.entries(shared)) {
  if (!name.endsWith("Schema") || !(value instanceof z.ZodType)) continue;
  const schema = z.toJSONSchema(value, { unrepresentable: "any" });
  expected.set(`${kebab(name)}.json`, `${JSON.stringify(schema, null, 2)}\n`);
}

mkdirSync(outDir, { recursive: true });
const existing = new Set(readdirSync(outDir).filter((file) => file.endsWith(".json")));

if (check) {
  const drift: string[] = [];
  for (const [file, content] of expected) {
    if (!existing.has(file) || readFileSync(join(outDir, file), "utf8") !== content)
      drift.push(file);
  }
  for (const file of existing) if (!expected.has(file)) drift.push(file);
  if (drift.length > 0) {
    console.error(`Contract drift in ${drift.join(", ")}. Run pnpm contract:build and commit.`);
    process.exit(1);
  }
  console.log(`Contract JSON Schema up to date (${expected.size} schemas).`);
} else {
  for (const file of existing) if (!expected.has(file)) rmSync(join(outDir, file));
  for (const [file, content] of expected) writeFileSync(join(outDir, file), content);
  console.log(`Wrote ${expected.size} JSON Schema files to src/json-schema.`);
}
