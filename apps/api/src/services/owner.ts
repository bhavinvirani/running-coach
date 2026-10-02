import { auth } from "../auth/auth";

export interface OwnerInput {
  email: string;
  password: string;
  /** Kept as is when omitted for an existing owner; defaults to the email's local part for a new one. */
  name?: string | undefined;
}

export type SeedOwnerResult = "created" | "updated" | "unchanged";

/**
 * Creates the owner with an email + password credential account, or brings an existing one in line with
 * the input. Uses Better Auth's own context, so the password hash is exactly what sign-in verifies. Safe to
 * run on every boot: an unchanged password is not rehashed and sessions stay valid.
 */
export async function seedOwner(input: OwnerInput): Promise<SeedOwnerResult> {
  const ctx = await auth.$context;
  const email = input.email.trim().toLowerCase();
  const existing = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });

  if (!existing) {
    const created = await ctx.internalAdapter.createUser(
      { email, name: input.name ?? email.split("@")[0] ?? email, emailVerified: true },
      { method: "email-password" },
    );
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: await ctx.password.hash(input.password),
    });
    return "created";
  }

  const { user, accounts } = existing;
  let changed = false;
  if (input.name !== undefined && input.name !== user.name) {
    await ctx.internalAdapter.updateUser(user.id, { name: input.name });
    changed = true;
  }
  const credential = accounts.find((item) => item.providerId === "credential");
  if (!credential) {
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await ctx.password.hash(input.password),
    });
    return "updated";
  }
  const samePassword =
    typeof credential.password === "string" &&
    (await ctx.password.verify({ hash: credential.password, password: input.password }));
  if (!samePassword) {
    await ctx.internalAdapter.updatePassword(user.id, await ctx.password.hash(input.password));
    changed = true;
  }
  return changed ? "updated" : "unchanged";
}
