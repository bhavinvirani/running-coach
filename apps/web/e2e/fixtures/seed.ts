import type { APIRequestContext } from "@playwright/test";
import {
  meResponseSchema,
  type MeResponse,
  type UpdateSettingsRequest,
} from "@running-coach/shared";

/**
 * The fictional runner every flow and screenshot runs as. playwright.config.ts passes these to the API as
 * OWNER_*, and its boot seeds the owner account from them. Invented on purpose: the repo and its
 * screenshots are public.
 */
export const runner = {
  name: "Jamie Example",
  email: "jamie@example.com",
  password: "e2e-only-password-1",
} as const;

export type Runner = typeof runner;

/** What a new account starts with (created with the account); every test starts from them. */
export const defaultSettings = {
  units: "km",
  timezone: "UTC",
  coachDetail: "standard",
} as const satisfies Required<UpdateSettingsRequest>;

/**
 * Puts the signed-in runner's settings back to the defaults through the API, the way the app changes them,
 * so a test never depends on what an earlier one left behind.
 */
export async function resetRunner(request: APIRequestContext): Promise<MeResponse> {
  const response = await request.patch("/api/me/settings", { data: defaultSettings });
  if (!response.ok()) {
    throw new Error(`Resetting the runner's settings failed with ${response.status()}`);
  }
  return meResponseSchema.parse(await response.json());
}
