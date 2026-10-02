import type { Express } from "express";
import request from "supertest";
import { expect } from "vitest";
import { createApp } from "../src/app";
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

/** Seeds the owner and signs in through Better Auth; the agent then carries the session cookie. */
export async function signedInAgent(app: Express, owner = TEST_OWNER) {
  await seedOwner(owner);
  const agent = browserAgent(app);
  const response = await agent
    .post("/api/auth/sign-in/email")
    .send({ email: owner.email, password: owner.password });
  expect(response.status).toBe(200);
  return agent;
}
