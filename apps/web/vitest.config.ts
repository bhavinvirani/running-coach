import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs in e2e/ run under Playwright, never Vitest.
    include: ["src/**/*.test.{ts,tsx}"],
    unstubGlobals: true,
    restoreMocks: true,
  },
});
