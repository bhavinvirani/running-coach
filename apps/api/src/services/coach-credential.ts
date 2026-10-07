import type { CoachCredential, CoachCredentialChoice } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import type { CoachCallCredential } from "../coach/client";
import { db } from "../db/client";
import { user, userSettings } from "../db/schema";
import { coachServiceOf, config } from "../lib/config";
import { decrypt } from "../lib/crypto";

// Which credential runs a user's coach. The Claude plan is a server secret the coach service holds for the
// owner alone, so it is offered only while the service is set up and only to OWNER_EMAIL; a plan choice
// stored for anyone else (the service's variables removed, the owner changed) falls back to the key
// without an error. The plan's token never reaches this API.

/** Whether the Claude plan is offered to the user with this email. */
export function claudePlanAvailable(email: string): boolean {
  const owner = config.OWNER_EMAIL;
  return (
    coachServiceOf(config) !== null &&
    owner !== undefined &&
    email.toLowerCase() === owner.toLowerCase()
  );
}

export interface CoachCredentialFacts {
  email: string;
  /** user_settings.coach_credential */
  choice: CoachCredentialChoice;
  hasClaudeKey: boolean;
}

/** The credential the coach uses now: the plan when offered and chosen, else a saved key, else none. */
export function effectiveCoachCredential({
  email,
  choice,
  hasClaudeKey,
}: CoachCredentialFacts): CoachCredential {
  if (choice === "plan" && claudePlanAvailable(email)) return "plan";
  return hasClaudeKey ? "key" : "none";
}

/** The user's credential as the coach would use it now. */
export async function coachCredentialOf(userId: string): Promise<CoachCredential> {
  const [row] = await db
    .select({
      email: user.email,
      choice: userSettings.coachCredential,
      claudeKeyEnc: userSettings.claudeKeyEnc,
    })
    .from(user)
    .innerJoin(userSettings, eq(userSettings.userId, user.id))
    .where(eq(user.id, userId));
  if (!row) return "none";
  return effectiveCoachCredential({
    email: row.email,
    choice: row.choice,
    hasClaudeKey: row.claudeKeyEnc !== null,
  });
}

/**
 * What runs the user's coach for one call: the Claude plan, or the saved key decrypted for this call only;
 * null when neither applies.
 */
export function callCredential(
  userId: string,
  settings: {
    email: string;
    coachCredential: CoachCredentialChoice;
    claudeKeyEnc: string | null;
  },
): CoachCallCredential | null {
  const { claudeKeyEnc } = settings;
  const credential = effectiveCoachCredential({
    email: settings.email,
    choice: settings.coachCredential,
    hasClaudeKey: claudeKeyEnc !== null,
  });
  if (credential === "plan") return { kind: "plan" };
  if (credential === "key" && claudeKeyEnc !== null) {
    return { kind: "key", apiKey: decrypt(claudeKeyEnc, userId) };
  }
  return null;
}
