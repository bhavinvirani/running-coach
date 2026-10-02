import { auth } from "../auth/auth";
import { createDefaultSettings } from "./settings";

export interface OwnerInput {
  email: string;
  password: string;
  /** Kept as is when omitted for an existing owner; defaults to the email's local part for a new one. */
  name?: string | undefined;
}

export interface SeedOwnerOptions {
  /**
   * `pnpm seed:owner`: also apply the name and password to an existing owner, and sign out all of the owner's
   * sessions when the password changes. Boot leaves an existing owner's name and password alone, so the env
   * value never overwrites a password changed since.
   */
  reset?: boolean;
}

/** `password_differs`: boot found OWNER_PASSWORD no longer matching the stored one and left it alone. */
export type SeedOwnerResult = "created" | "updated" | "unchanged" | "password_differs";

/**
 * Creates the owner with an email + password credential account when missing, and repairs an existing one
 * (a missing settings row or credential account). Uses Better Auth's own context, so the password hash is
 * exactly what sign-in verifies. Safe to run on every boot: nothing is rehashed and sessions stay valid.
 */
export async function seedOwner(
  input: OwnerInput,
  options: SeedOwnerOptions = {},
): Promise<SeedOwnerResult> {
  const ctx = await auth.$context;
  const email = input.email.trim().toLowerCase();
  const existing = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });

  if (!existing) {
    // The user.create.after hook in auth.ts inserts the settings row.
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
  // An owner created before the hook existed, or whose hook failed after the user was inserted.
  await createDefaultSettings(user.id);
  let changed = false;
  if (options.reset && input.name !== undefined && input.name !== user.name) {
    await ctx.internalAdapter.updateUser(user.id, { name: input.name });
    changed = true;
  }
  const credential = accounts.find((item) => item.providerId === "credential");
  if (!credential) {
    // A crash between createUser and linkAccount leaves an owner who cannot sign in.
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
  if (!options.reset) {
    if (changed) return "updated";
    return samePassword ? "unchanged" : "password_differs";
  }
  if (!samePassword) {
    await ctx.internalAdapter.updatePassword(user.id, await ctx.password.hash(input.password));
    // A session opened with the old password would otherwise live on for up to 30 days.
    await ctx.internalAdapter.deleteUserSessions(user.id);
    changed = true;
  }
  return changed ? "updated" : "unchanged";
}
