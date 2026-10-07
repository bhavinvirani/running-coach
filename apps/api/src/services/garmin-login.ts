import type {
  FinishGarminLoginRequest,
  GarminLoginConnected,
  StartGarminLoginRequest,
  StartGarminLoginResponse,
} from "@running-coach/shared";
import { garminClient } from "../garmin/client";
import { logger } from "../lib/logger";
import { connectGarmin } from "./garmin-connection";

const log = logger.child({ module: "garmin-login" });

// Connecting Garmin from the web app with email, password and the two-factor code (SPEC: Garmin). The
// Garmin service runs the password login and keeps it in its memory between the two calls, under the
// user id as loginId, so each runner has one and a new start replaces it. The bundle it answers then takes
// the laptop CLI's path (connectGarmin): one Garmin call proves it, it is stored encrypted, a push queued.
//
// The login itself runs outside withUserLock: it neither reads nor writes the stored bundle, and holding
// the lock for up to LOGIN_TIMEOUT_MS would stall the runner's sync and push behind a sign-in. Only
// connectGarmin, which writes, takes the lock. A failed login therefore stores nothing and touches no
// bookkeeping of the stored login: an expired one stays expired, and a Garmin 429 here starts none of
// openGarminAccount's hour, which belongs to the stored login. The email, password and code go to the
// service once and are never stored or logged (logger SENSITIVE_KEYS).

export interface StartGarminLoginInput extends StartGarminLoginRequest {
  userId: string;
}

/**
 * POST /api/garmin/login: code_needed when Garmin sent a code (finishGarminLogin within 5 min), or
 * connected when it asked for none. Throws garmin_credentials_rejected (422), garmin_rate_limited (429,
 * never retried) or garmin_unavailable (502), and the proof's errors when the new bundle fails it.
 */
export async function startGarminLogin({
  userId,
  email,
  password,
}: StartGarminLoginInput): Promise<StartGarminLoginResponse> {
  const answer = await garminClient.login({ loginId: userId, email, password });
  if (answer.status === "code_needed") {
    log.info({ userId }, "garmin login waits for a code");
    return { status: "code_needed" };
  }
  return store(userId, answer.tokenBundle);
}

export interface FinishGarminLoginInput extends FinishGarminLoginRequest {
  userId: string;
}

/**
 * POST /api/garmin/login/code: the code for the login the runner started. Throws garmin_mfa_rejected (422;
 * the same login takes another code) or garmin_login_lost (409; start again).
 */
export async function finishGarminLogin({
  userId,
  mfaCode,
}: FinishGarminLoginInput): Promise<GarminLoginConnected> {
  const { tokenBundle } = await garminClient.loginCode({ loginId: userId, mfaCode });
  return store(userId, tokenBundle);
}

async function store(userId: string, tokenBundle: string): Promise<GarminLoginConnected> {
  const { displayName } = await connectGarmin({ userId, tokenBundle });
  return { status: "connected", displayName };
}
