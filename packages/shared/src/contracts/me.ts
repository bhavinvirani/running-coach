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

export const garminStatusSchema = z.enum(["not_connected", "ok", "expired"]);
export type GarminStatus = z.infer<typeof garminStatusSchema>;

export const settingsSchema = z
  .object({
    units: unitsSchema,
    timezone: timeZoneSchema,
    coachDetail: coachDetailSchema,
    hasClaudeKey: z.boolean(),
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
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Send at least one setting");
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
