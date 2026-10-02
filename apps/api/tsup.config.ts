import { defineConfig } from "tsup";

// Production bundle: the server, the owner seed and the migration CLI as ESM for Node 24. Workspace packages
// ship TypeScript source, so they are bundled in; npm dependencies stay external and load from node_modules.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "seed-owner": "src/scripts/seed-owner.ts",
    "migrate-cli": "src/db/migrate-cli.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node24",
  noExternal: [/^@running-coach\//],
  sourcemap: true,
  clean: true,
  splitting: true,
  dts: false,
});
