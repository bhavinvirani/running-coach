import { z } from "zod";

/**
 * The one list of error codes. The API, the Garmin service and the web app all use these values.
 * Adding a code adds its user-facing message in apps/web/src/lib/errors.ts in the same PR.
 */
export const ErrorCode = {
  validation: "validation",
  unauthorized: "unauthorized",
  notFound: "not_found",
  rateLimited: "rate_limited",
  internal: "internal",
  garminNotConnected: "garmin_not_connected",
  garminAuthExpired: "garmin_auth_expired",
  garminRateLimited: "garmin_rate_limited",
  garminUnavailable: "garmin_unavailable",
  garminMfaRequired: "garmin_mfa_required",
  claudeKeyMissing: "claude_key_missing",
  claudeKeyInvalid: "claude_key_invalid",
  claudeUnavailable: "claude_unavailable",
  /** A custom workout names the plan's zones: none can be built without an active plan. */
  planMissing: "plan_missing",
  /** A session that is past, done, missed or skipped, or a change the session's source does not allow. */
  sessionLocked: "session_locked",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const errorCodeSchema = z.enum(ErrorCode);
