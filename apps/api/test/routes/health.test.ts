import { problemSchema } from "@running-coach/shared";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerReadinessCheck } from "../../src/lib/lifecycle";
import { createTestApp } from "../helpers";

describe("GET /health", () => {
  const app = createTestApp();

  it("returns 200 ok without a session and echoes a request id", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toMatch(/^[\w.:-]+$/);
  });

  it("keeps a sane x-request-id from the caller and replaces an unsafe one", async () => {
    const kept = await request(app).get("/health").set("x-request-id", "web-123.abc");
    const replaced = await request(app).get("/health").set("x-request-id", "bad id <script>");

    expect(kept.headers["x-request-id"]).toBe("web-123.abc");
    expect(replaced.headers["x-request-id"]).not.toContain("bad id");
  });

  it("returns 503 problem+json naming the dependency that is down", async () => {
    let up = true;
    registerReadinessCheck("garmin", () => up);
    up = false;

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const problem = problemSchema.parse(response.body);
    expect(problem.detail).toContain("garmin");

    up = true;
    expect((await request(app).get("/health")).status).toBe(200);
  });
});
