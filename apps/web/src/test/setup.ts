import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// Unit tests never load mapbox-gl, whatever the shell exports: RouteMap draws the sketch. The one test of
// the map path stubs its own token; unstubEnvs in vitest.config.ts restores this after every test.
beforeEach(() => {
  vi.stubEnv("VITE_MAPBOX_TOKEN", "");
});

afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver; Recharts' ResponsiveContainer subscribes to one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
