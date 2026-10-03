import { type Problem, problemSchema } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { expect } from "vitest";
import { createApp } from "../src/app";
import { db } from "../src/db/client";
import { user } from "../src/db/schema";
import { config } from "../src/lib/config";
import { seedOwner } from "../src/services/owner";

// A fictional owner; example.com is reserved for documentation.
export const TEST_OWNER = {
  email: "runner@example.com",
  password: "correct-horse-battery-staple",
  name: "Test Runner",
} as const;

export function createTestApp(): Express {
  return createApp();
}

let lastIp = 0;

/**
 * A fresh client address from TEST-NET-3 per agent. Better Auth's in-memory rate limit is keyed on IP and path
 * and lives for the whole file, so agents must not share a bucket unless a test means them to.
 */
export function nextTestIp(): string {
  lastIp += 1;
  return `203.0.113.${lastIp}`;
}

/** A supertest agent that looks like the web app: same origin, its own IP. */
export function browserAgent(app: Express) {
  return request.agent(app).set("origin", config.APP_URL).set("x-forwarded-for", nextTestIp());
}

/**
 * Seeds the owner, or another user given, and signs in through Better Auth; the agent then carries the
 * session cookie.
 */
export async function signedInAgent(
  app: Express,
  owner: { email: string; password: string; name: string } = TEST_OWNER,
) {
  await seedOwner(owner);
  const agent = browserAgent(app);
  const response = await agent
    .post("/api/auth/sign-in/email")
    .send({ email: owner.email, password: owner.password });
  expect(response.status).toBe(200);
  return agent;
}

/** The seeded owner's user id. */
export async function ownerId(email: string = TEST_OWNER.email): Promise<string> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error("owner missing; call signedInAgent or seedOwner first");
  return row.id;
}

/** Asserts a problem+json response with this status and code, echoing the request id; returns the problem. */
export function expectProblem(response: request.Response, status: number, code: string): Problem {
  expect(response.status).toBe(status);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  const problem = problemSchema.parse(response.body);
  expect(problem.code).toBe(code);
  expect(problem.requestId).toBe(response.headers["x-request-id"]);
  return problem;
}

/** The SQLSTATE a query failed with (drizzle wraps the pg error as its cause), or undefined if it worked. */
export async function postgresErrorCode(query: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    return ((error as { cause?: { code?: string } }).cause ?? (error as { code?: string })).code;
  }
  return undefined;
}
