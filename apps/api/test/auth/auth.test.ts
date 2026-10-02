import { problemSchema } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { session, user } from "../../src/db/schema";
import { seedOwner } from "../../src/services/owner";
import { browserAgent, createTestApp, signedInAgent, TEST_OWNER } from "../helpers";

const app = createTestApp();

describe("POST /api/auth/sign-up/email", () => {
  it("is refused with 400 problem+json and creates no user", async () => {
    const response = await browserAgent(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "someone@example.com", password: "a-long-enough-password", name: "Someone" });

    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(problemSchema.parse(response.body).code).toBe("validation");
    expect(await db.select().from(user)).toHaveLength(0);
  });
});

describe("POST /api/auth/sign-in/email", () => {
  it("signs the owner in with a session cookie that opens /api/me", async () => {
    const agent = await signedInAgent(app);

    const me = await agent.get("/api/me");

    expect(me.status).toBe(200);
    expect(await db.select().from(session)).toHaveLength(1);
  });

  it("returns 401 unauthorized for a wrong password and creates no session", async () => {
    await seedOwner(TEST_OWNER);

    const response = await browserAgent(app)
      .post("/api/auth/sign-in/email")
      .send({ email: TEST_OWNER.email, password: "not-the-password" });

    expect(response.status).toBe(401);
    expect(problemSchema.parse(response.body).code).toBe("unauthorized");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(await db.select().from(session)).toHaveLength(0);
  });

  it("returns 401 unauthorized for an unknown email", async () => {
    const response = await browserAgent(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "nobody@example.com", password: "whatever-password" });

    expect(response.status).toBe(401);
    expect(problemSchema.parse(response.body).code).toBe("unauthorized");
  });

  it("rate limits after 10 attempts a minute from one IP with 429 and Retry-After", async () => {
    await seedOwner(TEST_OWNER);
    const agent = browserAgent(app);
    const attempt = () =>
      agent
        .post("/api/auth/sign-in/email")
        .send({ email: TEST_OWNER.email, password: "not-the-password" });

    for (let i = 0; i < 10; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    const limited = await attempt();

    expect(limited.status).toBe(429);
    const problem = problemSchema.parse(limited.body);
    expect(problem.code).toBe("rate_limited");
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers["retry-after"]).toBe(String(problem.retryAfterSeconds));

    // Another client is not affected.
    const other = await browserAgent(app)
      .post("/api/auth/sign-in/email")
      .send({ email: TEST_OWNER.email, password: TEST_OWNER.password });
    expect(other.status).toBe(200);
  });

  it("keys the rate limit on the proxy-reported IP, not on a header the client picks", async () => {
    await seedOwner(TEST_OWNER);
    const agent = browserAgent(app);

    for (let i = 0; i < 10; i += 1) {
      await agent
        .post("/api/auth/sign-in/email")
        .set("x-running-coach-client-ip", `198.51.100.${i}`)
        .send({ email: TEST_OWNER.email, password: "not-the-password" });
    }
    const limited = await agent
      .post("/api/auth/sign-in/email")
      .set("x-running-coach-client-ip", "198.51.100.200")
      .send({ email: TEST_OWNER.email, password: TEST_OWNER.password });

    expect(limited.status).toBe(429);
  });
});

describe("POST /api/auth/sign-out", () => {
  it("ends the session so /api/me returns 401", async () => {
    const agent = await signedInAgent(app);

    const signOut = await agent.post("/api/auth/sign-out").send({});
    const me = await agent.get("/api/me");

    expect(signOut.status).toBe(200);
    expect(me.status).toBe(401);
  });

  it("is refused from another origin while a session cookie is present", async () => {
    const agent = await signedInAgent(app);

    const response = await agent
      .post("/api/auth/sign-out")
      .set("origin", "https://evil.example.com")
      .send({});

    expect(response.status).toBe(403);
    expect((await agent.get("/api/me")).status).toBe(200);
  });
});
