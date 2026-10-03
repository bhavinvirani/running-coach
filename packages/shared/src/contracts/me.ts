import { z } from "zod";
import { unitsSchema } from "../units";

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z.string().min(1).refine(isIanaTimeZone, "Unknown IANA time zone");

export const coachDetailSchema = z.enum(["short", "standard", "detailed"]);
export type CoachDetail = z.infer<typeof coachDetailSchema>;

/**
 * What runs the coach. key: the user's own Claude API key (PUT /api/me/claude-key). plan: the owner's
 * Claude plan, through the coach service, whose token is a server secret and never a user's.
 */
export const coachCredentialChoiceSchema = z.enum(["key", "plan"]);
export type CoachCredentialChoice = z.infer<typeof coachCredentialChoiceSchema>;

/** The credential the coach uses now; none when the choice is key and no key is saved. */
export const coachCredentialSchema = z.enum(["key", "plan", "none"]);
export type CoachCredential = z.infer<typeof coachCredentialSchema>;

export const garminStatusSchema = z.enum(["not_connected", "ok", "expired"]);
export type GarminStatus = z.infer<typeof garminStatusSchema>;

export const settingsSchema = z
  .object({
    units: unitsSchema,
    timezone: timeZoneSchema,
    coachDetail: coachDetailSchema,
    hasClaudeKey: z.boolean(),
    coachCredential: coachCredentialSchema,
    /** True only for the owner, when the server has the coach service set up: Settings offers the plan. */
    claudePlanAvailable: z.boolean(),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;

/** GET /api/me */
export const meResponseSchema = z
  .object({
    user: z.object({ id: z.uuid(), email: z.email(), name: z.string() }).strict(),
    settings: settingsSchema,
    garmin: z
      .object({ status: garminStatusSchema, lastSyncAt: z.iso.datetime().nullable() })
      .strict(),
  })
  .strict();
export type MeResponse = z.infer<typeof meResponseSchema>;

/** PATCH /api/me/settings; responds with meResponseSchema. */
export const updateSettingsRequestSchema = z
  .object({
    units: unitsSchema.optional(),
    timezone: timeZoneSchema.optional(),
    coachDetail: coachDetailSchema.optional(),
    /** plan answers 409 claude_plan_unavailable unless claudePlanAvailable. */
    coachCredential: coachCredentialChoiceSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Send at least one setting");
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
