import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { account, session, user } from "../../src/db/schema";
import { seedOwner } from "../../src/services/owner";
import { browserAgent, createTestApp, TEST_OWNER } from "../helpers";

const app = createTestApp();

async function signIn(email: string, password: string): Promise<number> {
  const response = await browserAgent(app)
    .post("/api/auth/sign-in/email")
    .send({ email, password });
  return response.status;
}

describe("seedOwner", () => {
  it("creates a verified user with a hashed credential account that can sign in", async () => {
    expect(await seedOwner(TEST_OWNER)).toBe("created");

    const [owner] = await db.select().from(user);
    expect(owner).toMatchObject({
      email: TEST_OWNER.email,
      name: TEST_OWNER.name,
      emailVerified: true,
    });
    const [credential] = await db
      .select()
      .from(account)
      .where(eq(account.userId, owner?.id ?? ""));
    expect(credential?.providerId).toBe("credential");
    expect(credential?.password).toBeTruthy();
    expect(credential?.password).not.toContain(TEST_OWNER.password);
    expect(await signIn(TEST_OWNER.email, TEST_OWNER.password)).toBe(200);
  });

  it("normalizes the email so sign-in matches Better Auth's lowercase lookup", async () => {
    await seedOwner({ ...TEST_OWNER, email: "  Runner@Example.COM " });

    expect(await signIn(TEST_OWNER.email, TEST_OWNER.password)).toBe(200);
  });

  it("defaults the name to the email's local part", async () => {
    await seedOwner({ email: TEST_OWNER.email, password: TEST_OWNER.password });

    const [owner] = await db.select().from(user);
    expect(owner?.name).toBe("runner");
  });

  it("updates the password and name of an existing owner, keeping one user and one account", async () => {
    await seedOwner(TEST_OWNER);
    const newPassword = "a-different-long-password";

    const result = await seedOwner({
      ...TEST_OWNER,
      password: newPassword,
      name: "Renamed Runner",
    });

    expect(result).toBe("updated");
    expect(await db.select().from(user)).toHaveLength(1);
    expect(await db.select().from(account)).toHaveLength(1);
    const [owner] = await db.select().from(user);
    expect(owner?.name).toBe("Renamed Runner");
    expect(await signIn(TEST_OWNER.email, TEST_OWNER.password)).toBe(401);
    expect(await signIn(TEST_OWNER.email, newPassword)).toBe(200);
  });

  it("is idempotent: the same input changes nothing and keeps sessions valid", async () => {
    await seedOwner(TEST_OWNER);
    const [before] = await db.select().from(account);
    const agent = browserAgent(app);
    await agent
      .post("/api/auth/sign-in/email")
      .send({ email: TEST_OWNER.email, password: TEST_OWNER.password });

    const result = await seedOwner(TEST_OWNER);

    expect(result).toBe("unchanged");
    const [after] = await db.select().from(account);
    expect(after?.password).toBe(before?.password);
    expect(await db.select().from(session)).toHaveLength(1);
    expect((await agent.get("/api/me")).status).toBe(200);
  });

  it("keeps the existing name when none is given", async () => {
    await seedOwner(TEST_OWNER);

    await seedOwner({ email: TEST_OWNER.email, password: TEST_OWNER.password });

    const [owner] = await db.select().from(user);
    expect(owner?.name).toBe(TEST_OWNER.name);
  });
});
