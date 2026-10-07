import type { ErrorCode } from "@running-coach/shared";
import { isApiError, isContractMismatch } from "@/api/client";
import { ScreenLoadError } from "@/app/lazy-screen";

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
  garmin_credentials_rejected:
    "Garmin did not accept this email and password. Check them and try again.",
  garmin_mfa_rejected: "Garmin did not accept this code. Type the newest code Garmin sent.",
  garmin_login_lost:
    "This Garmin sign-in is no longer open. Start again with your email and password.",
  claude_key_missing: "No Claude API key is set. Add one in Settings.",
  // Shown on Settings, where the key is saved; a run's card for a rejected key links to Settings itself.
  claude_key_invalid:
    "Claude rejected this key. Copy it again from the Claude Console and save it.",
  claude_unavailable: "Claude is not responding. Try again in a few minutes.",
  // Settings offers the plan from a cached /api/me; the server may have stopped offering it since.
  claude_plan_unavailable:
    "The Claude plan is not set up for this account. Use an API key instead.",
  claude_plan_limited:
    "Your Claude plan has reached its usage limit. The coach tries again when the limit resets.",
  plan_missing: "Workouts read their paces from your plan. Set a goal first.",
  // Also an open pause's hold on a move, skip, edit or add: no code of its own, since workouts_push_error
  // checks every code.
  session_locked:
    "This session can no longer change: it is past, done or skipped, or training is paused. Refresh to see it, or tap I'm back on Today.",
};

export const networkErrorMessage =
  "Could not reach the server. Check your connection and try again.";
export const unknownErrorMessage = "Something went wrong. Try again.";
/**
 * The server runs another version than this page (after a deploy or a rollback): an answer it cannot read,
 * or a screen whose code is gone. Shown only beside Reload (ScreenErrorBoundary, RetryAlert, RunDetail).
 */
export const versionMismatchMessage =
  "This version of the app does not match the server. Reload to get the current one.";
/** A write whose 2xx this version could not read: it may have gone through, and trying again could repeat it. */
export const unreadWriteMessage =
  "The server may have done this already, but this version of the app could not read its answer. Check before trying again.";

/** An error only another version of the app can fix: Reload, never Retry. */
export function isVersionMismatch(error: unknown): boolean {
  return isContractMismatch(error) || error instanceof ScreenLoadError;
}

/** What to show the user for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ScreenLoadError) {
    return error.offline ? networkErrorMessage : versionMismatchMessage;
  }
  if (!isApiError(error)) return unknownErrorMessage;
  if (error.network) return networkErrorMessage;
  if (error.contractMismatch === "write") return unreadWriteMessage;
  if (error.contractMismatch === "read") return versionMismatchMessage;
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
