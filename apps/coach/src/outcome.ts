import type {
  ModelUsage,
  SDKAssistantMessageError,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKStartupFailureReason,
} from "@anthropic-ai/claude-agent-sdk";
import {
  COACH_RUN_MAX_RETRY_AFTER_S,
  type CoachRunFailure,
  type CoachRunResponse,
  type CoachRunUsage,
} from "@running-coach/shared";

// What Claude Code's messages said about one run, and the outcome they add up to. Pure, so every mapping
// is tested without a process. Field names follow the Agent SDK 0.3.288 types (sdk.d.ts).

/** Claude Code labels the assistant frames it writes itself for an API error with this model. */
const SYNTHETIC_MODEL = "<synthetic>";

/** Without a reset time the plan's limit is retried in an hour; never sooner than a minute. */
const DEFAULT_RETRY_AFTER_S = 3600;
const MIN_RETRY_AFTER_S = 60;

const AUTH_ERRORS = new Set<SDKAssistantMessageError>([
  "authentication_failed",
  "oauth_org_not_allowed",
]);
const TRANSIENT_ERRORS = new Set<SDKAssistantMessageError>([
  "rate_limit",
  "overloaded",
  "server_error",
  "unknown",
]);
const REJECTED_ERRORS = new Set<SDKAssistantMessageError>([
  "billing_error",
  "account_on_hold",
  "verification_required",
  "invalid_request",
  "model_not_found",
  "cloud_credential_error",
]);
// Startup failures where the sign-in itself is refused, so only a new plan token helps. The rest are the
// box or the CLI (temp dir, cwd, version, proxy) or may pass later: org_verify_failed is a network
// failure or a revoked token, which Claude Code cannot tell apart.
const AUTH_STARTUP_FAILURES = new Set<SDKStartupFailureReason>([
  "org_pin_mismatch",
  "org_pin_api_key_conflict",
  "gateway_signin_required",
]);

export interface RunObservation {
  result: SDKResultMessage | undefined;
  /** The last assistant frame's error: Claude Code's reading of the API error that ended the run. */
  assistantError: SDKAssistantMessageError | undefined;
  refused: boolean;
  truncated: boolean;
  /** The last model that answered; the fallback model when Claude Code switched to it. */
  model: string | undefined;
  claudeRequestId: string | undefined;
  /** The plan's latest rate-limit status, and the latest rejection if any. */
  rateLimit: SDKRateLimitInfo | undefined;
  rejectedLimit: SDKRateLimitInfo | undefined;
}

export function newObservation(): RunObservation {
  return {
    result: undefined,
    assistantError: undefined,
    refused: false,
    truncated: false,
    model: undefined,
    claudeRequestId: undefined,
    rateLimit: undefined,
    rejectedLimit: undefined,
  };
}

/** Folds one SDK message into the observation. */
export function observe(observation: RunObservation, message: SDKMessage): void {
  switch (message.type) {
    case "assistant": {
      const { model, stop_reason: stopReason } = message.message;
      if (message.error !== undefined) observation.assistantError = message.error;
      if (message.error === "max_output_tokens" || stopReason === "max_tokens") {
        observation.truncated = true;
      }
      // A refusal arrives as an invalid_request frame whose stop reason is "refusal".
      if (stopReason === "refusal") observation.refused = true;
      if (model && model !== SYNTHETIC_MODEL) observation.model = model;
      if (message.request_id) observation.claudeRequestId = message.request_id;
      return;
    }
    case "system":
      if (message.subtype === "model_refusal_no_fallback") observation.refused = true;
      return;
    case "rate_limit_event":
      observation.rateLimit = message.rate_limit_info;
      if (message.rate_limit_info.status === "rejected") {
        observation.rejectedLimit = message.rate_limit_info;
      }
      return;
    case "result":
      observation.result = message;
      return;
    default:
      return;
  }
}

/** Seconds until the plan's limit resets: resetsAt is Unix seconds (the unified-reset header). */
export function retryAfterSeconds(limit: SDKRateLimitInfo, nowMs: number): number {
  if (limit.resetsAt === undefined) return DEFAULT_RETRY_AFTER_S;
  const seconds = Math.ceil(limit.resetsAt - nowMs / 1000);
  // A wait beyond the plan's longest window means a misread reset time, not a real limit.
  return Math.min(COACH_RUN_MAX_RETRY_AFTER_S, Math.max(MIN_RETRY_AFTER_S, seconds));
}

/** Why Claude Code refused to start, from the result it writes with CLAUDE_CODE_STARTUP_FAILURE_RESULTS. */
export function startupFailureOf(
  result: SDKResultMessage | undefined,
): SDKStartupFailureReason | undefined {
  return result === undefined || result.subtype === "success"
    ? undefined
    : result.startup_failure_reason;
}

const tokenCount = (value: number | undefined) =>
  Number.isFinite(value) && (value ?? 0) > 0 ? Math.round(value ?? 0) : 0;

/**
 * The run's tokens across models. Input counts cache reads and writes too: Claude Code caches its prompt,
 * while an API-key call has no cache, so this keeps the two credentials' input comparable.
 */
export function usageOf(result: SDKResultMessage | undefined): CoachRunUsage | null {
  if (result === undefined) return null;
  const perModel: Partial<ModelUsage>[] = Object.values(result.modelUsage ?? {});
  const totals =
    perModel.length > 0
      ? perModel
      : [
          {
            inputTokens: result.usage?.input_tokens,
            outputTokens: result.usage?.output_tokens,
            cacheReadInputTokens: result.usage?.cache_read_input_tokens,
            cacheCreationInputTokens: result.usage?.cache_creation_input_tokens,
          },
        ];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const usage of totals) {
    inputTokens +=
      tokenCount(usage.inputTokens) +
      tokenCount(usage.cacheReadInputTokens) +
      tokenCount(usage.cacheCreationInputTokens);
    outputTokens += tokenCount(usage.outputTokens);
  }
  return { inputTokens, outputTokens };
}

/** The model with the most output in the run, for a result whose assistant frames named none. */
function modelOfUsage(result: SDKResultMessage): string | undefined {
  let best: { model: string; output: number } | undefined;
  for (const [model, usage] of Object.entries(result.modelUsage ?? {})) {
    const output = tokenCount(usage.outputTokens);
    if (!best || output > best.output) best = { model, output };
  }
  return best?.model;
}

/** Why a run without a usable structured output failed. */
export function failureOf(observation: RunObservation): CoachRunFailure {
  const { result, assistantError: error } = observation;
  const startupFailure = startupFailureOf(result);
  if (startupFailure !== undefined) {
    return AUTH_STARTUP_FAILURES.has(startupFailure) ? "plan_auth_failed" : "unavailable";
  }
  if (error !== undefined && AUTH_ERRORS.has(error)) return "plan_auth_failed";
  if (observation.rejectedLimit !== undefined) return "plan_limited";
  if (observation.refused || result?.stop_reason === "refusal") return "refusal";
  if (observation.truncated || result?.stop_reason === "max_tokens") return "max_tokens";
  if (error !== undefined && TRANSIENT_ERRORS.has(error)) return "unavailable";
  if (error !== undefined && REJECTED_ERRORS.has(error)) return "request_rejected";
  // No result: the CLI crashed, failed to start or was killed.
  if (result === undefined) return "unavailable";
  switch (result.subtype) {
    case "error_max_structured_output_retries":
    case "error_max_turns":
      return "invalid_output";
    case "success": {
      if (!result.is_error) return "invalid_output";
      // An API error Claude Code gave no assistant error for: read its HTTP status.
      const status = result.api_error_status ?? null;
      if (status === 401) return "plan_auth_failed";
      if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return "request_rejected";
      }
      return "unavailable";
    }
    default:
      return "unavailable";
  }
}

/**
 * The response for a finished run. Only a success result that is not an error and carries the structured
 * output is ok: Claude Code ends an API error with a success result whose is_error is true.
 */
export function classifyRun(
  observation: RunObservation,
  context: { nowMs: number; requestedModel: string },
): CoachRunResponse {
  const { result } = observation;
  const claudeRequestId = observation.claudeRequestId ?? null;
  const usage = usageOf(result);
  if (result?.subtype === "success" && !result.is_error && result.structured_output !== undefined) {
    return {
      ok: true,
      output: result.structured_output,
      model: observation.model ?? modelOfUsage(result) ?? context.requestedModel,
      usage: usage ?? { inputTokens: 0, outputTokens: 0 },
      claudeRequestId,
    };
  }
  return failure(failureOf(observation), observation, context.nowMs);
}

/** A failure response; usage only when a model spent tokens on the run. */
export function failure(
  reason: CoachRunFailure,
  observation: RunObservation,
  nowMs: number,
): CoachRunResponse {
  const usage = usageOf(observation.result);
  const spent = usage !== null && usage.inputTokens + usage.outputTokens > 0;
  return {
    ok: false,
    failure: reason,
    ...(reason === "plan_limited"
      ? {
          retryAfterSeconds: observation.rejectedLimit
            ? retryAfterSeconds(observation.rejectedLimit, nowMs)
            : DEFAULT_RETRY_AFTER_S,
        }
      : {}),
    usage: spent ? usage : null,
    claudeRequestId: observation.claudeRequestId ?? null,
  };
}
