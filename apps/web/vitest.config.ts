import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs in e2e/ (*.spec.ts) run under Playwright, never Vitest; only the e2e fixtures' own
    // unit tests (*.test.ts) run here.
    include: ["src/**/*.test.{ts,tsx}", "e2e/fixtures/*.test.ts"],
    unstubGlobals: true,
    unstubEnvs: true,
    restoreMocks: true,
  },
});
