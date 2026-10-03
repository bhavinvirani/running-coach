import { defineProject } from "vitest/config";

// Every run goes through the real Agent SDK against test/fake-claude-code.mjs, which speaks Claude Code's
// stream-json protocol; tests build their own config, so nothing here reaches the service's env.
export default defineProject({
  test: {
    name: "coach",
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
