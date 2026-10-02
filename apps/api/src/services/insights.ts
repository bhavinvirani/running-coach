import { ErrorCode } from "@running-coach/shared";
import { and, eq } from "drizzle-orm";
import { runInsight } from "../coach/run-insight";
import { db } from "../db/client";
import { activity, type CoachMessage, coachMessage, userSettings } from "../db/schema";
import { decrypt } from "../lib/crypto";
import { DomainError } from "../lib/errors";
import { logger } from "../lib/logger";

const log = logger.child({ module: "insights" });

/**
 * Writes the coach's card for one of the user's runs and stores it as a coach_message. Without a Claude
 * key no call is made and the fallback card is stored; a failed call stores the fallback card too, with
 * the usage it was billed. The key is decrypted here, used for this one call and never returned.
 */
export async function createRunInsight(userId: string, activityId: string): Promise<CoachMessage> {
  const [run] = await db
    .select()
    .from(activity)
    .where(and(eq(activity.id, activityId), eq(activity.userId, userId)));
  if (!run) throw new DomainError(ErrorCode.notFound, 404, "That run does not exist.");

  const [settings] = await db
    .select({
      units: userSettings.units,
      coachDetail: userSettings.coachDetail,
      claudeKeyEnc: userSettings.claudeKeyEnc,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  // The settings row is created with the user (src/auth/auth.ts).
  if (!settings) throw new Error("The user has no settings row");
  const apiKey = settings.claudeKeyEnc ? decrypt(settings.claudeKeyEnc, userId) : null;

  const result = await runInsight({
    apiKey,
    activity: run,
    settings: { units: settings.units, coachDetail: settings.coachDetail },
  });

  const [message] = await db
    .insert(coachMessage)
    .values({
      userId,
      kind: "insight",
      activityId: run.id,
      promptVersion: result.promptVersion,
      model: result.model,
      content: result.content,
      usage: result.usage,
    })
    .returning();
  if (!message) throw new Error("coach_message insert returned nothing");

  log.info(
    {
      coachMessageId: message.id,
      claudeRequestId: result.requestId,
      model: result.model,
      fallbackReason: result.fallbackReason,
      usage: result.usage,
    },
    "run insight stored",
  );
  return message;
}
