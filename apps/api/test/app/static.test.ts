import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";

// A stand-in for apps/web/dist, so the test does not depend on a web build.
const webDist = mkdtempSync(path.join(tmpdir(), "web-dist-"));
mkdirSync(path.join(webDist, "assets"));
writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>Running Coach</title>");
writeFileSync(path.join(webDist, "assets", "index-abc123.js"), "console.log(1)");
writeFileSync(path.join(webDist, "sw.js"), "self.skipWaiting()");
writeFileSync(path.join(webDist, "manifest.webmanifest"), "{}");

const app = createApp({ webDist });

afterAll(() => {
  rmSync(webDist, { recursive: true, force: true });
});

describe("serving the web app", () => {
  it("serves hashed assets with an immutable cache", async () => {
    const response = await request(app).get("/assets/index-abc123.js");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("serves the service worker, the manifest and index.html itself with no-cache", async () => {
    // The web app reads /index.html to learn whether a reload would load another version (app-update.ts).
    for (const file of ["/sw.js", "/manifest.webmanifest", "/index.html"]) {
      const response = await request(app).get(file);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("answers client routes with index.html and no-cache", async () => {
    const response = await request(app).get("/runs/2026-09-27");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.text).toContain("Running Coach");
  });

  it("returns 404 for a missing file instead of index.html", async () => {
    const response = await request(app).get("/assets/missing-123.js");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });

  it("never answers /api paths with index.html", async () => {
    const response = await request(app).get("/api/unknown");

    expect(response.headers["content-type"]).toContain("application/problem+json");
  });

  it("sends a CSP and the other helmet headers", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    // APP_URL is http in tests, so browsers must not be told to upgrade requests.
    expect(response.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("lets the run screen's Mapbox map load: its API, its blob: workers and blob: images, nothing wider", async () => {
    const response = await request(app).get("/");
    const directives = new Map(
      String(response.headers["content-security-policy"])
        .split(";")
        .map((directive) => directive.trim().split(/\s+/))
        .map(([name = "", ...sources]) => [name, sources]),
    );

    expect(directives.get("connect-src")).toEqual([
      "'self'",
      "https://api.mapbox.com",
      "https://events.mapbox.com",
    ]);
    // 'self' keeps the app's own service worker allowed.
    expect(directives.get("worker-src")).toEqual(["'self'", "blob:"]);
    expect(directives.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
  });
});
