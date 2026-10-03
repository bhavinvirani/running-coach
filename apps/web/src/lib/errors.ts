import type { ErrorCode } from "@running-coach/shared";
import { isApiError } from "@/api/client";

/**
 * The one place user-facing error text lives. Each message says what happened and what to do.
 * Typed as a full record, so adding a code in packages/shared fails the typecheck until it has a message here.
 */
export const errorMessages: Record<ErrorCode, string> = {
  validation: "Some of what you sent was not accepted. Check it and try again.",
  unauthorized: "You are logged out. Log in again.",
  not_found: "That item no longer exists. Go back and refresh.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  internal: "Something failed on the server. Try again in a minute.",
  garmin_not_connected: "Garmin is not connected. Connect it in Settings.",
  garmin_auth_expired: "Garmin login expired. Reconnect in Settings.",
  // "Try again", not "sync again": the run screen's Garmin fetch shows it too.
  garmin_rate_limited: "Garmin is limiting requests. Wait an hour, then try again.",
  garmin_unavailable: "Garmin is not responding. Try again later.",
  garmin_mfa_required: "Garmin asked for a two-factor code. Reconnect in Settings.",
  claude_key_missing: "No Claude API key is set. Add one in Settings.",
  // Shown on Settings, where the key is saved; a run's card for a rejected key links to Settings itself.
  claude_key_invalid:
    "Claude rejected this key. Copy it again from the Claude Console and save it.",
  claude_unavailable: "Claude is not responding. Try again in a few minutes.",
  plan_missing: "Workouts read their paces from your plan. Set a goal first.",
  session_locked:
    "This session can no longer change: it is past, done or skipped. Refresh to see it.",
};

export const networkErrorMessage =
  "Could not reach the server. Check your connection and try again.";
export const unknownErrorMessage = "Something went wrong. Try again.";

/** What to show the user for any thrown value. */
export function errorMessage(error: unknown): string {
  if (!isApiError(error)) return unknownErrorMessage;
  if (error.network) return networkErrorMessage;
  return errorMessages[error.code];
}

/** What to show for an error code the API stored with a resource (a failed import), when it has one. */
export function errorCodeMessage(code: ErrorCode | null | undefined): string {
  return code ? errorMessages[code] : unknownErrorMessage;
}

/** On the login form a 401 means the credentials were wrong, not that a session ended. */
export function logInErrorMessage(error: unknown): string {
  if (isApiError(error) && !error.network && error.code === "unauthorized") {
    return "Email or password is wrong. Check both and try again.";
  }
  return errorMessage(error);
}
