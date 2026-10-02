import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../lib/config";
import { currentRequestId, logger } from "../lib/logger";
import { paths } from "../lib/paths";

// The only caller of Claude (api rule). One request per call with the user's own key, the system prompt
// from a versioned file, and structured output from the prompt's zod schema. stop_reason is checked
// before parsing, and the output is parsed with the schema; any failure comes back as a result the
// caller turns into its fallback card. Never logs the key, the prompt input or the model's text.

const log = logger.child({ module: "coach" });

export const INSIGHT_MAX_TOKENS = 4096;
export const PLAN_MAX_TOKENS = 16_384;

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const RETRY_BASE_DELAY_MS = 1000;

/** Tokens billed for one message, stored in coach_message.usage. */
export interface CoachUsage {
  inputTokens: number;
  outputTokens: number;
}

export type CoachFailure =
  "refusal" | "max_tokens" | "invalid_output" | "timeout" | "unavailable" | "key_invalid";

export type CoachResult<T> =
  | { ok: true; output: T; model: string; usage: CoachUsage; requestId: string | null }
  | {
      ok: false;
      failure: CoachFailure;
      /** Set when a model answered, unusably; its tokens were billed. */
      usage: CoachUsage | null;
      requestId: string | null;
    };

export interface CoachCall<T extends z.ZodType> {
  /** The user's decrypted key, used for this call only. */
  apiKey: string;
  /** Folder under src/coach/prompts. */
  prompt: string;
  /** "v1": prompts/<prompt>/<version>.md is the system prompt. */
  version: string;
  /** The user message, from the prompt's input.ts. */
  input: string;
  schema: T;
  maxTokens: number;
}

const promptCache = new Map<string, string>();

/** A prompt file, read once per process. */
export async function loadPrompt(prompt: string, version: string): Promise<string> {
  const key = `${prompt}/${version}`;
  const cached = promptCache.get(key);
  if (cached !== undefined) return cached;
  const text = await readFile(path.join(paths.prompts, prompt, `${version}.md`), "utf8");
  promptCache.set(key, text);
  return text;
}

function usageOf(message: Anthropic.Message): CoachUsage {
  return { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

function failureOf(error: unknown): CoachFailure | undefined {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.AuthenticationError) return "key_invalid";
  if (error instanceof Anthropic.PermissionDeniedError) return "key_invalid";
  if (error instanceof Anthropic.APIError) return "unavailable";
  return undefined;
}

type Parsed<T> = { ok: true; output: T } | { ok: false; issues: string[] };

function parseOutput<T extends z.ZodType>(
  message: Anthropic.Message,
  schema: T,
): Parsed<z.output<T>> {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issues: ["(not JSON)"] };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, output: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => issue.path.join(".") || "(root)"),
  };
}

/**
 * Calls Claude once with COACH_MODEL at low effort. On 429, 529, 5xx or a dropped connection it waits
 * with jitter and tries once more, on COACH_FALLBACK_MODEL: the primary is likely still overloaded and
 * the fallback has its own rate limits. A timeout is not retried; the 60 s already spent is the budget.
 */
export async function callCoach<T extends z.ZodType>(
  call: CoachCall<T>,
): Promise<CoachResult<z.output<T>>> {
  const system = await loadPrompt(call.prompt, call.version);
  const promptVersion = `${call.prompt}/${call.version}`;
  const client = new Anthropic({
    apiKey: call.apiKey,
    // Only the user's key: never a token or base URL from the server's environment.
    authToken: null,
    baseURL: config.CLAUDE_BASE_URL ?? DEFAULT_BASE_URL,
    timeout: config.CLAUDE_TIMEOUT_MS,
    // Retries are ours, below, so the fallback model takes the second attempt.
    maxRetries: 0,
    logLevel: "off",
  });
  const requestId = currentRequestId();
  const models = [config.COACH_MODEL, config.COACH_FALLBACK_MODEL];

  for (const [attempt, model] of models.entries()) {
    const started = Date.now();
    try {
      // Thinking stays adaptive (it cannot be turned off on Opus 5.5); low effort keeps it short.
      const message = await client.messages.create(
        {
          model,
          max_tokens: call.maxTokens,
          system,
          messages: [{ role: "user", content: call.input }],
          output_config: { effort: "low", format: zodOutputFormat(call.schema) },
        },
        requestId ? { headers: { "x-request-id": requestId } } : undefined,
      );
      const context = {
        promptVersion,
        model: message.model,
        claudeRequestId: message._request_id ?? null,
        usage: usageOf(message),
        durationMs: Date.now() - started,
      };
      const failed = (failure: CoachFailure): CoachResult<z.output<T>> => ({
        ok: false,
        failure,
        usage: context.usage,
        requestId: context.claudeRequestId,
      });

      if (message.stop_reason === "refusal") {
        log.warn({ ...context, category: message.stop_details?.category ?? null }, "coach refused");
        return failed("refusal");
      }
      if (message.stop_reason === "max_tokens") {
        log.warn(context, "coach output hit max_tokens");
        return failed("max_tokens");
      }
      if (message.stop_reason !== "end_turn") {
        log.warn({ ...context, stopReason: message.stop_reason }, "coach stopped unexpectedly");
        return failed("invalid_output");
      }
      const parsed = parseOutput(message, call.schema);
      if (!parsed.ok) {
        log.warn({ ...context, issues: parsed.issues }, "coach output failed its schema");
        return failed("invalid_output");
      }
      log.info(context, "coach answered");
      return {
        ok: true,
        output: parsed.output,
        model: message.model,
        usage: context.usage,
        requestId: context.claudeRequestId,
      };
    } catch (error) {
      const status =
        error instanceof Anthropic.APIError && typeof error.status === "number"
          ? error.status
          : null;
      const claudeRequestId =
        error instanceof Anthropic.APIError ? (error.requestID ?? null) : null;
      if (isRetryable(error) && attempt < models.length - 1) {
        log.warn({ promptVersion, model, status, claudeRequestId }, "coach call failed; retrying");
        await sleep(RETRY_BASE_DELAY_MS + Math.random() * RETRY_BASE_DELAY_MS);
        continue;
      }
      const failure = failureOf(error);
      if (!failure) throw error;
      log.warn({ promptVersion, model, status, claudeRequestId, failure }, "coach call failed");
      return { ok: false, failure, usage: null, requestId: claudeRequestId };
    }
  }
  // Unreachable: the last attempt always returns or throws.
  throw new Error("coach call ended without a result");
}
