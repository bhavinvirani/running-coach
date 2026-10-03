import { ErrorCode, type MeResponse } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { checkClaudeKey } from "../coach/client";
import { db } from "../db/client";
import { userSettings } from "../db/schema";
import { encrypt } from "../lib/crypto";
import { DomainError } from "../lib/errors";
import { logger } from "../lib/logger";
import { getMe } from "./settings";

// The user's own Claude key: checked with Claude before it is stored, stored encrypted, never returned.

const log = logger.child({ module: "claude-key" });

/**
 * PUT /api/me/claude-key: asks Claude whether the key works (GET /v1/models, free) and stores it encrypted
 * only when it does. A rejected key is 422 and a Claude that does not answer is 502; both store nothing, so
 * a key saved earlier stays in use. `key` arrives trimmed by claudeKeyRequestSchema.
 */
export async function saveClaudeKey(userId: string, key: string): Promise<MeResponse> {
  const check = await checkClaudeKey(key);
  if (check === "key_invalid") {
    throw new DomainError(
      ErrorCode.claudeKeyInvalid,
      422,
      "Claude rejected this key. Check that you copied all of it and that it is active, then save it again.",
    );
  }
  if (check !== "ok") {
    throw new DomainError(
      ErrorCode.claudeUnavailable,
      502,
      "Claude did not answer, so the key was not saved. Try again in a few minutes.",
    );
  }
  await db
    .update(userSettings)
    .set({ claudeKeyEnc: encrypt(key, userId) })
    .where(eq(userSettings.userId, userId));
  log.info({ userId }, "claude key saved");
  return getMe(userId);
}

/**
 * DELETE /api/me/claude-key: forgets the key. A run's coach job queued before it finds no key and stores
 * nothing; stored cards stay.
 */
export async function removeClaudeKey(userId: string): Promise<MeResponse> {
  await db.update(userSettings).set({ claudeKeyEnc: null }).where(eq(userSettings.userId, userId));
  log.info({ userId }, "claude key removed");
  return getMe(userId);
}
