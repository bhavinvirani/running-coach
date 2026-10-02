import { defineConfig } from "vitest/config";

// One Vitest run over every package; each package's vitest.config.ts names its project.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
