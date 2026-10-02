import { defineConfig, defineProject, mergeConfig } from "vitest/config";

// Coverage is a root-only Vitest option, so defineProject rejects it. It applies when the package
// runs on its own (`pnpm --filter @running-coach/engine test`) and is ignored inside the root run.
export default mergeConfig(
  defineProject({
    test: {
      name: "engine",
      environment: "node",
    },
  }),
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: ["src/rules/**"],
        exclude: ["src/**/*.test.ts"],
        thresholds: { branches: 100, lines: 100 },
      },
    },
  }),
);
