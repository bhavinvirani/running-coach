// A stand-in for Claude Code's CLI, for tests and e2e (CLAUDE_CODE_EXECUTABLE points here; the Agent SDK
// runs a .mjs path with node). It speaks the stream-json protocol the SDK drives: an initialize
// control_request answered with a control_response, the user message, then system/init, assistant,
// rate_limit_event and result frames shaped like Claude Code 2.1.288's, sanitized, with fake run data.
//
// The plan token picks the scenario: CLAUDE_CODE_OAUTH_TOKEN=test-<scenario>.<nonce>; any other value is
// rejected the way Claude rejects a bad token. Each process appends JSON lines to
// ${os.tmpdir()}/fake-claude-code-<nonce>.jsonl: its argv and the NAMES of its env vars (never values,
// except the non-secret flags below), which earlier processes of the token were still alive when it
// started, the initialize request, the user message, an ignored SIGTERM and its exit, so tests assert
// the flags, the env allowlist and that runs never overlap.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const TOKEN_PATTERN = /^test-([a-z0-9-]+)\.([\w-]+)$/;
const NON_SECRET_ENV = [
  "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
];

const match = TOKEN_PATTERN.exec(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "");
const scenario = match?.[1] ?? "auth-failed";
const nonce = match?.[2];
const logFile = nonce ? path.join(tmpdir(), `fake-claude-code-${nonce}.jsonl`) : undefined;

function record(event) {
  if (logFile) {
    appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...event })}\n`);
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Pids of the processes this token started before this one. */
function earlierPids() {
  if (!logFile || !existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "start" && event.pid !== process.pid)
    .map((event) => event.pid);
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const model = flag("--model") ?? "claude-opus-5-5";
const fallbackModel = flag("--fallback-model") ?? "claude-sonnet-5-5";
const maxOutputTokens = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? "32000";
const sessionId = randomUUID();
const earlier = earlierPids();

record({
  event: "start",
  // Earlier processes of this token still running: a run that overlaps the one before it.
  alive: earlier.filter(isAlive),
  argv,
  envNames: Object.keys(process.env).sort(),
  env: Object.fromEntries(
    NON_SECRET_ENV.filter((key) => key in process.env).map((key) => [key, process.env[key]]),
  ),
});

// A run-insight card of fake data that passes runInsightSchema in packages/shared.
const CARD = {
  headline: "Easy 8.0 km at 5:30 per km, heart rate 146 bpm",
  whatHappened:
    "You ran 8.0 km in 44:00 at an even 5:30 per km. Average heart rate 146 bpm, in your easy zone.",
  whatItMeans:
    "Pace and heart rate matched the easy run planned for today. Aerobic work with no extra fatigue.",
  nextStep: "Rest tomorrow. Thursday's 6 x 800 m intervals stay as planned.",
  caution: "none",
};

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: null,
};

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const ids = () => ({ uuid: randomUUID(), session_id: sessionId });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage(input, output, cacheRead = 0, cacheCreation = 0) {
  return {
    ...ZERO_USAGE,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    service_tier: "standard",
  };
}

function modelUsage(name, input, output, cacheRead = 0, cacheCreation = 0) {
  return {
    [name]: {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 200000,
      maxOutputTokens: Number(maxOutputTokens),
    },
  };
}

function init() {
  send({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    tools: ["StructuredOutput"],
    mcp_servers: [],
    model,
    permissionMode: "auto",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "2.1.288",
    output_style: "default",
    agents: [],
    skills: [],
    plugins: [],
    analytics_disabled: true,
    ...ids(),
  });
}

function rateLimit(info) {
  send({ type: "rate_limit_event", rate_limit_info: info, ...ids() });
}

function apiRetry(attempt, error, status) {
  send({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 2,
    retry_delay_ms: 500,
    error_status: status,
    error,
    ...ids(),
  });
}

function assistant(message, extra = {}) {
  send({
    type: "assistant",
    message: {
      id: `msg_fake_${randomUUID().slice(0, 8)}`,
      type: "message",
      role: "assistant",
      model,
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      usage: ZERO_USAGE,
      ...message,
    },
    parent_tool_use_id: null,
    ...extra,
    ...ids(),
  });
}

/** The frame Claude Code writes itself for an API error: a synthetic assistant message. */
function apiError(text, error, extra = {}) {
  assistant(
    {
      id: randomUUID(),
      model: "<synthetic>",
      content: [{ type: "text", text }],
      stop_reason: "stop_sequence",
      stop_sequence: "",
    },
    { error, is_api_error_message: true, ...extra },
  );
}

function structuredOutputCall(input, answeredBy = model) {
  const toolUseId = `toolu_fake_${randomUUID().slice(0, 8)}`;
  assistant(
    {
      model: answeredBy,
      content: [{ type: "tool_use", id: toolUseId, name: "StructuredOutput", input }],
      stop_reason: "tool_use",
      usage: usage(6, 210, 0, 1890),
    },
    { request_id: `req_fake_${nonce ?? "none"}` },
  );
  return toolUseId;
}

function toolResult(toolUseId, content, isError = false) {
  send({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    ...ids(),
  });
}

function result(fields) {
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1500,
    duration_api_ms: 1200,
    num_turns: 1,
    result: "",
    stop_reason: "tool_use",
    total_cost_usd: 0,
    usage: ZERO_USAGE,
    modelUsage: {},
    permission_denials: [],
    terminal_reason: "completed",
    ...fields,
    ...ids(),
  });
}

/** An API error that ends the run: Claude Code exits 1 after the error result. */
function failWith(text, error, status, extra = {}) {
  apiError(text, error, extra);
  result({
    is_error: true,
    api_error_status: status,
    result: text,
    stop_reason: "stop_sequence",
    terminal_reason: "api_error",
  });
  exitCode = 1;
}

// As Claude Code 2.1.288 answered a real run: the StructuredOutput call, its tool result, the plan's
// rate-limit status (utilization only inside unifiedWindows), then a result counting two turns.
function succeed(answeredBy = model) {
  const toolUseId = structuredOutputCall(CARD, answeredBy);
  toolResult(toolUseId, "Structured output provided successfully");
  const resetsAt = nowSeconds() + 3 * 3600;
  rateLimit({
    status: "allowed",
    resetsAt,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.16, resetsAt },
      seven_day: { utilization: 0.61, resetsAt: resetsAt + 4 * 86400 },
    },
  });
  result({
    num_turns: 2,
    api_error_status: null,
    result: JSON.stringify(CARD),
    structured_output: CARD,
    usage: usage(6, 210, 0, 1890),
    modelUsage: modelUsage(answeredBy, 6, 210, 0, 1890),
  });
}

const scenarios = {
  success: () => succeed(),
  // Claude Code switched to the fallback model after the model was overloaded.
  fallback: () => {
    apiRetry(1, "overloaded", 529);
    succeed(fallbackModel);
  },
  // Slow enough for a second request to queue behind it.
  slow: async () => {
    await sleep(400);
    succeed();
  },
  "auth-failed": () => {
    apiRetry(1, "authentication_failed", 401);
    apiRetry(2, "authentication_failed", 401);
    failWith(
      "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      "authentication_failed",
      401,
    );
  },
  "usage-limit": () => {
    rateLimit({
      status: "rejected",
      resetsAt: nowSeconds() + 7200,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
    });
    failWith("You've hit your limit · resets 7pm (UTC)", "rate_limit", 429);
  },
  "structured-retries": () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const toolUseId = structuredOutputCall({ headline: attempt });
      toolResult(toolUseId, "Output does not match the required schema", true);
    }
    result({
      subtype: "error_max_structured_output_retries",
      is_error: true,
      num_turns: 4,
      errors: ["No attempt produced a valid structured output"],
      terminal_reason: "structured_output_retry_exhausted",
      usage: usage(18, 630, 0, 5670),
      modelUsage: modelUsage(model, 18, 630, 0, 5670),
    });
    exitCode = 1;
  },
  // Refused by the model and again by the fallback model Claude Code retried on.
  refusal: () => {
    send({
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      original_model: model,
      fallback_model: fallbackModel,
      request_id: `req_fake_refusal_1_${nonce ?? "none"}`,
      content: "",
      ...ids(),
    });
    assistant(
      {
        id: randomUUID(),
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: Claude can't help with this." }],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null, explanation: null },
      },
      {
        error: "invalid_request",
        is_api_error_message: true,
        request_id: `req_fake_refusal_2_${nonce ?? "none"}`,
      },
    );
    result({
      is_error: true,
      result: "API Error: Claude can't help with this.",
      stop_reason: "refusal",
      terminal_reason: "model_error",
      usage: usage(12, 3, 0, 3780),
      modelUsage: modelUsage(fallbackModel, 12, 3, 0, 3780),
    });
    exitCode = 1;
  },
  "max-tokens": () => {
    assistant(
      {
        content: [{ type: "text", text: "Easy 8.0 km at" }],
        stop_reason: "max_tokens",
        usage: usage(6, Number(maxOutputTokens), 0, 1890),
      },
      { request_id: `req_fake_${nonce ?? "none"}` },
    );
    apiError(
      `API Error: Claude's response exceeded the ${maxOutputTokens} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
      "max_output_tokens",
    );
    result({
      is_error: true,
      result: "API Error: Claude's response exceeded the output token maximum.",
      stop_reason: "max_tokens",
      terminal_reason: "model_error",
      usage: usage(6, Number(maxOutputTokens), 0, 1890),
      modelUsage: modelUsage(model, 6, Number(maxOutputTokens), 0, 1890),
    });
    exitCode = 1;
  },
  overloaded: () => {
    apiRetry(1, "overloaded", 529);
    apiRetry(2, "overloaded", 529);
    failWith("API Error: Repeated 529 Overloaded errors", "overloaded", 529);
  },
  billing: () => {
    failWith(
      "API Error: 400 Your credit balance is too low to access the Anthropic API.",
      "billing_error",
      400,
    );
  },
  // Started, then never answers and ignores stdin closing: only a signal ends it.
  hang: () => undefined,
  // The token's first process hangs like hang and also ignores SIGTERM, so only SIGKILL ends it; later
  // processes of the token answer, so a test sees whether the run queued behind it overlapped it.
  "hang-stubborn": () => (stubborn ? undefined : succeed()),
  // Died mid-run without a result, after writing to stderr: Claude Code's exit 1 on an unexpected error.
  crash: () => {
    process.stderr.write(`${CRASH_TEXT}\n`, () => exit({ code: 1 }));
  },
};

const INITIALIZE_RESPONSE = {
  commands: [],
  agents: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: [],
  account: {},
};

let exitCode = 0;
let answered = false;
const stubborn = scenario === "hang-stubborn" && earlier.length === 0;

// Fake stderr text, which the service may count but never log.
const CRASH_TEXT = "Error: fake unexpected failure inside the fake Claude Code";
const STARTUP_FAILURE_TEXT =
  "Claude Code could not create its temp directory: fake-tmp/claude is not writable";

function exit(fields) {
  record({ event: "exit", ...fields });
  process.exit(fields.code);
}

process.on("SIGTERM", () => {
  if (stubborn) {
    record({ event: "sigterm", ignored: true });
    return;
  }
  exit({ code: 143, signal: "SIGTERM" });
});

/**
 * A known startup failure: before it reads stdin, Claude Code writes the cause to stderr and, only when
 * the host set CLAUDE_CODE_STARTUP_FAILURE_RESULTS, a zeroed error_during_execution result naming the
 * reason, then exits 1.
 */
function failAtStartup(reason, text) {
  const frames = process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS
    ? `${JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 0,
        stop_reason: null,
        total_cost_usd: 0,
        usage: ZERO_USAGE,
        modelUsage: {},
        permission_denials: [],
        errors: [text],
        startup_failure_reason: reason,
        ...ids(),
      })}\n`
    : "";
  process.stderr.write(`${text}\n`, () => {
    process.stdout.write(frames, () => exit({ code: 1 }));
  });
}

if (scenario === "startup-failure") {
  failAtStartup("temp_dir_unusable", STARTUP_FAILURE_TEXT);
} else {
  listen();
}

function listen() {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      const { subtype } = message.request;
      if (subtype === "initialize") {
        record({
          event: "initialize",
          systemPrompt: message.request.systemPrompt,
          jsonSchema: message.request.jsonSchema,
        });
      }
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: subtype === "initialize" ? INITIALIZE_RESPONSE : {},
        },
      });
      return;
    }
    if (message.type === "user" && !answered) {
      answered = true;
      const text = message.message.content.map((block) => block.text ?? "").join("");
      record({ event: "user", text });
      init();
      const play = scenarios[scenario] ?? scenarios["auth-failed"];
      void Promise.resolve(play()).then(() => record({ event: "played", scenario }));
    }
  });
  // The SDK closes stdin once it has the result; a hung CLI ignores it.
  lines.on("close", () => {
    if (scenario === "hang" || stubborn) {
      setInterval(() => undefined, 1000);
      return;
    }
    exit({ code: exitCode });
  });
}
