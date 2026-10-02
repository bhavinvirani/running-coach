import { ErrorCode, problemSchema, updateSettingsRequestSchema } from "@running-coach/shared";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DomainError, errorHandler, notFoundHandler } from "../../src/lib/errors";
import { parse, respond } from "../../src/lib/http";
import { requestIdMiddleware } from "../../src/lib/logger";
import { createTestApp } from "../helpers";
import { z } from "zod";

function appThatThrows(error: () => unknown) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.get("/boom", () => {
    throw error();
  });
  app.post("/parse", (req, res) => {
    respond(res, z.object({ ok: z.boolean() }), {
      ok: !!parse(updateSettingsRequestSchema, req.body),
    });
  });
  app.get("/bad-output", (_req, res) => {
    respond(res, z.object({ ok: z.boolean() }).strict(), { ok: true, secret: "leak" } as never);
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("renders a DomainError as problem+json with its code, status, detail and request id", async () => {
    const app = appThatThrows(
      () =>
        new DomainError(ErrorCode.garminRateLimited, 429, "Garmin asked us to wait.", {
          retryAfterSeconds: 3600,
        }),
    );

    const response = await request(app).get("/boom").set("x-request-id", "req-42");

    expect(response.status).toBe(429);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["retry-after"]).toBe("3600");
    expect(problemSchema.parse(response.body)).toEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "garmin_rate_limited",
      detail: "Garmin asked us to wait.",
      requestId: "req-42",
      retryAfterSeconds: 3600,
    });
  });

  it("turns an unknown error into a 500 internal that hides the message and stack", async () => {
    const app = appThatThrows(
      () => new Error("connect ECONNREFUSED secret-host:5432 password=hunter2"),
    );

    const response = await request(app).get("/boom");

    expect(response.status).toBe(500);
    const problem = problemSchema.parse(response.body);
    expect(problem.code).toBe("internal");
    expect(response.text).not.toContain("hunter2");
    expect(response.text).not.toContain("ECONNREFUSED");
    expect(response.text).not.toContain("at ");
  });

  it("turns a thrown non-Error into a 500 internal", async () => {
    const app = appThatThrows(() => "a string");

    const response = await request(app).get("/boom");

    expect(response.status).toBe(500);
    expect(problemSchema.parse(response.body).code).toBe("internal");
  });

  it("turns an input zod failure into 400 validation with flattened issues", async () => {
    const response = await request(appThatThrows(() => null))
      .post("/parse")
      .send({ units: "furlongs", extra: 1 });

    expect(response.status).toBe(400);
    const problem = problemSchema.parse(response.body);
    expect(problem.code).toBe("validation");
    expect(problem.issues?.map((issue) => issue.path).sort()).toEqual(["", "units"]);
  });

  it("turns a malformed JSON body into 400 validation", async () => {
    const response = await request(appThatThrows(() => null))
      .post("/parse")
      .set("content-type", "application/json")
      .send('{"units":');

    expect(response.status).toBe(400);
    expect(problemSchema.parse(response.body).code).toBe("validation");
  });

  it("treats a response that breaks its own schema as a 500, not a 400", async () => {
    const response = await request(appThatThrows(() => null)).get("/bad-output");

    expect(response.status).toBe(500);
    expect(response.text).not.toContain("leak");
  });

  it("answers an unknown path with 404 not_found", async () => {
    const response = await request(appThatThrows(() => null)).get("/nowhere");

    expect(response.status).toBe(404);
    expect(problemSchema.parse(response.body).code).toBe("not_found");
  });
});

describe("the app's error paths", () => {
  const app = createTestApp();

  it("answers an unknown /api path with problem+json, never HTML", async () => {
    const response = await request(app).get("/api/nothing-here");

    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(problemSchema.parse(response.body).status).toBe(response.status);
  });

  it("rejects a body over 1 MB with 413 validation", async () => {
    const response = await request(app)
      .patch("/api/me/settings")
      .set("content-type", "application/json")
      .send(`{"units":"${"x".repeat(1024 * 1024)}"}`);

    expect(response.status).toBe(413);
    expect(problemSchema.parse(response.body).code).toBe("validation");
  });
});
