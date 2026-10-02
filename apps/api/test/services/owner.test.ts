import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { account, session, user, userSettings } from "../../src/db/schema";
import { seedOwner } from "../../src/services/owner";
import { browserAgent, createTestApp, ownerId, signedInAgent, TEST_OWNER } from "../helpers";
import { createUser } from "../seed";

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

  it("creates the default settings row with the user", async () => {
    await seedOwner(TEST_OWNER);

    const rows = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, await ownerId()));
    expect(rows).toEqual([
      expect.objectContaining({ units: "km", timezone: "UTC", coachDetail: "standard" }),
    ]);
  });

  it("gives an existing owner without settings or a credential both, so the owner can sign in", async () => {
    // An owner created before the settings hook existed: a user row and nothing else.
    const userId = await createUser(TEST_OWNER.email);
    await db.delete(userSettings).where(eq(userSettings.userId, userId));

    const result = await seedOwner(TEST_OWNER);

    expect(result).toBe("updated");
    expect(
      await db.select().from(userSettings).where(eq(userSettings.userId, userId)),
    ).toHaveLength(1);
    expect(await signIn(TEST_OWNER.email, TEST_OWNER.password)).toBe(200);
  });

  it("at boot leaves an existing owner's password and name alone, and its sessions signed in", async () => {
    const agent = await signedInAgent(app);

    const result = await seedOwner({
      ...TEST_OWNER,
      password: "a-different-long-password",
      name: "Renamed Runner",
    });

    expect(result).toBe("password_differs");
    const [owner] = await db.select().from(user);
    expect(owner?.name).toBe(TEST_OWNER.name);
    expect(await signIn(TEST_OWNER.email, TEST_OWNER.password)).toBe(200);
    expect((await agent.get("/api/me")).status).toBe(200);
  });

  it("at boot reports unchanged when the env password still matches", async () => {
    await signedInAgent(app);

    expect(await seedOwner({ ...TEST_OWNER })).toBe("unchanged");
  });

  it("with reset updates the password and name of an existing owner, keeping one user and one account", async () => {
    await seedOwner(TEST_OWNER);
    const newPassword = "a-different-long-password";

    const result = await seedOwner(
      { ...TEST_OWNER, password: newPassword, name: "Renamed Runner" },
      { reset: true },
    );

    expect(result).toBe("updated");
    expect(await db.select().from(user)).toHaveLength(1);
    expect(await db.select().from(account)).toHaveLength(1);
    const [owner] = await db.select().from(user);
    expect(owner?.name).toBe("Renamed Runner");
    expect(await signIn(TEST_OWNER.email, TEST_OWNER.password)).toBe(401);
    expect(await signIn(TEST_OWNER.email, newPassword)).toBe(200);
  });

  it("with reset signs out every session of the owner when the password changes", async () => {
    const agent = await signedInAgent(app);

    await seedOwner({ ...TEST_OWNER, password: "a-different-long-password" }, { reset: true });

    expect(await db.select().from(session)).toHaveLength(0);
    expect((await agent.get("/api/me")).status).toBe(401);
  });

  it("is idempotent: the same input with reset changes nothing and keeps sessions valid", async () => {
    await seedOwner(TEST_OWNER);
    const [before] = await db.select().from(account);
    const agent = browserAgent(app);
    await agent
      .post("/api/auth/sign-in/email")
      .send({ email: TEST_OWNER.email, password: TEST_OWNER.password });

    const result = await seedOwner(TEST_OWNER, { reset: true });

    expect(result).toBe("unchanged");
    const [after] = await db.select().from(account);
    expect(after?.password).toBe(before?.password);
    expect(await db.select().from(session)).toHaveLength(1);
    expect((await agent.get("/api/me")).status).toBe(200);
  });

  it("with reset keeps the existing name when none is given", async () => {
    await seedOwner(TEST_OWNER);

    await seedOwner({ email: TEST_OWNER.email, password: TEST_OWNER.password }, { reset: true });

    const [owner] = await db.select().from(user);
    expect(owner?.name).toBe(TEST_OWNER.name);
  });
});
