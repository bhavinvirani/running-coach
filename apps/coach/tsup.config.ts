import { defineConfig } from "tsup";

// Production bundle: the server as ESM for Node 24. The shared contracts ship TypeScript source, so they
// are bundled in. npm dependencies stay external; the Agent SDK must, because it finds Claude Code's
// native binary in its platform package beside it in node_modules.
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node24",
  noExternal: [/^@running-coach\//],
  external: ["@anthropic-ai/claude-agent-sdk"],
  sourcemap: true,
  clean: true,
  dts: false,
});
