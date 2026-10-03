import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Options,
  query,
  type SDKRateLimitInfo,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { CoachRunRequest, CoachRunResponse } from "@running-coach/shared";
import { z } from "zod";
import { type Config, systemEnv } from "./config";
import type { Logger } from "./logger";
import {
  classifyRun,
  failure,
  newObservation,
  observe,
  type RunObservation,
  startupFailureOf,
} from "./outcome";

// Runs one prompt through Claude Code (the Agent SDK's bundled CLI) on the owner's plan. One CLI at a time:
// each holds 200 to 250 MB, and the free instance has 512 MB.

// A valid structured output on the first try counts two turns (the StructuredOutput call and its tool
// result, measured on Claude Code 2.1.288); the slack lets Claude Code retry an output that failed the
// schema before it gives up with error_max_turns or error_max_structured_output_retries.
export const MAX_TURNS = 4;
// After an abort the SDK closes stdin, sends SIGTERM 2 s later and SIGKILL 5 s after that. The next run
// waits for the exit, so a CLI that outlives the SIGTERM is killed here sooner.
const KILL_AFTER_ABORT_MS = 3_000;

// Claude Code 2.1.288 reports the plan's utilization (0 to 1) per window in unifiedWindows, a field the
// SDK's types leave out, so it is parsed defensively and only for the log.
const unifiedWindowsSchema = z.record(
  z.string(),
  z.object({ utilization: z.number().optional() }).loose(),
);

/** The plan's rate-limit status for the run's log line. */
function rateLimitSummary(info: SDKRateLimitInfo) {
  const windows = unifiedWindowsSchema.safeParse(
    (info as { unifiedWindows?: unknown }).unifiedWindows,
  );
  const utilization = windows.success
    ? Object.fromEntries(
        Object.entries(windows.data).flatMap(([name, window]) =>
          window.utilization === undefined ? [] : [[name, window.utilization]],
        ),
      )
    : (info.utilization ?? null);
  return {
    status: info.status,
    rateLimitType: info.rateLimitType ?? null,
    utilization,
    resetsAt: info.resetsAt ?? null,
  };
}

export interface Runner {
  /** Runs one request after those before it; null when the caller hung up before or during its run. */
  run(request: CoachRunRequest, signal: AbortSignal): Promise<CoachRunResponse | null>;
  /** Aborts the running CLI and skips queued requests; resolves once no CLI is left. */
  shutdown(): Promise<void>;
}

/** Claude Code's whole environment: the option replaces the child's, so nothing else is inherited. */
export function childEnv(config: Config, maxTokens: number): Record<string, string> {
  const token = config.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    ...systemEnv({ keychainLogin: token === undefined && config.NODE_ENV === "development" }),
    ...(token === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: token }),
    // Claude Code's own retries on overload and 5xx; the API's job retries cover longer outages.
    CLAUDE_CODE_MAX_RETRIES: "2",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    // A known startup failure then ends in a result naming its reason instead of stderr alone.
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
  };
}

/** The query options for one run: no tools, settings, MCP servers or saved session; low effort. */
export function queryOptions(
  request: CoachRunRequest,
  context: {
    config: Config;
    cwd: string;
    abortController: AbortController;
    spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
  },
): Options {
  const { config } = context;
  return {
    // A string replaces Claude Code's default system prompt.
    systemPrompt: request.system,
    model: request.model,
    // The SDK refuses a fallback model equal to the model.
    ...(request.fallbackModel === request.model ? {} : { fallbackModel: request.fallbackModel }),
    effort: "low",
    outputFormat: { type: "json_schema", schema: request.jsonSchema },
    maxTurns: MAX_TURNS,
    tools: [],
    settingSources: [],
    persistSession: false,
    mcpServers: {},
    strictMcpConfig: true,
    cwd: context.cwd,
    abortController: context.abortController,
    env: childEnv(config, request.maxTokens),
    ...(config.CLAUDE_CODE_EXECUTABLE === undefined
      ? {}
      : { pathToClaudeCodeExecutable: config.CLAUDE_CODE_EXECUTABLE }),
    spawnClaudeCodeProcess: context.spawnClaudeCodeProcess,
  };
}

/** Spawns Claude Code like the SDK does, but keeps the process so a run can wait for its exit. */
function trackedSpawner() {
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<void> = Promise.resolve();
  let stderrBytes = 0;
  return {
    spawn(options: SpawnOptions): SpawnedProcess {
      const started = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      // Read stderr so a chatty CLI never blocks on a full pipe; only its size is ever logged.
      started.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
      });
      exited = new Promise((resolve) => {
        started.once("exit", () => resolve());
        // The SDK's abort of options.signal makes Node send SIGTERM and emit 'error' at once, while a
        // CLI that ignores the SIGTERM still runs; only a process that never started is gone on 'error'.
        started.on("error", () => {
          if (started.pid === undefined) resolve();
        });
      });
      child = started;
      return started;
    },
    get stderrBytes() {
      return stderrBytes;
    },
    /** Resolves once the CLI has exited, sending SIGKILL when it outlives KILL_AFTER_ABORT_MS. */
    async stopped(): Promise<void> {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const running = child;
      const timer = setTimeout(() => running.kill("SIGKILL"), KILL_AFTER_ABORT_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** A FIFO lock: each task starts when the one before it settled. */
function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task);
      tail = run.catch(() => undefined);
      return run;
    },
    idle(): Promise<unknown> {
      return tail;
    },
  };
}

type StopReason = "timeout" | "hangup" | "shutdown";

export function createRunner({ config, logger }: { config: Config; logger: Logger }): Runner {
  const queue = createQueue();
  let abortCurrent: (() => void) | undefined;
  let closed = false;

  async function execute(request: CoachRunRequest, signal: AbortSignal) {
    const startedAt = performance.now();
    // An empty working directory: Claude Code finds no project files, settings or memory in it.
    const cwd = await mkdtemp(path.join(tmpdir(), "coach-run-"));
    const abortController = new AbortController();
    let stop: StopReason | undefined;
    const abort = (reason: StopReason) => {
      stop ??= reason;
      abortController.abort();
    };
    const timer = setTimeout(() => abort("timeout"), config.COACH_RUN_TIMEOUT_MS);
    const onHangup = () => abort("hangup");
    signal.addEventListener("abort", onHangup, { once: true });
    abortCurrent = () => abort("shutdown");
    if (signal.aborted) onHangup();
    if (closed) abort("shutdown");

    const spawner = trackedSpawner();
    const observation = newObservation();
    let crash: unknown;
    try {
      const run = query({
        prompt: request.input,
        options: queryOptions(request, {
          config,
          cwd,
          abortController,
          spawnClaudeCodeProcess: (options) => spawner.spawn(options),
        }),
      });
      try {
        for await (const message of run) observe(observation, message);
      } finally {
        run.close();
      }
    } catch (error) {
      crash = error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onHangup);
      abortCurrent = undefined;
      await spawner.stopped();
      await rm(cwd, { recursive: true, force: true });
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const response = outcome(stop, observation, request);
    logRun({
      request,
      observation,
      response,
      stop,
      durationMs,
      crash,
      stderrBytes: spawner.stderrBytes,
    });
    return stop === "hangup" ? null : response;
  }

  function outcome(
    stop: StopReason | undefined,
    observation: RunObservation,
    request: CoachRunRequest,
  ): CoachRunResponse {
    const nowMs = Date.now();
    // A result that arrived before the abort still counts.
    if (stop === undefined || observation.result !== undefined) {
      return classifyRun(observation, { nowMs, requestedModel: request.model });
    }
    return failure(stop === "timeout" ? "timeout" : "unavailable", observation, nowMs);
  }

  function logRun(entry: {
    request: CoachRunRequest;
    observation: RunObservation;
    response: CoachRunResponse;
    stop: StopReason | undefined;
    durationMs: number;
    crash: unknown;
    stderrBytes: number;
  }) {
    const { observation, response } = entry;
    const { result, rateLimit } = observation;
    const startupFailureReason = startupFailureOf(result);
    const fields = {
      model: response.ok ? response.model : (observation.model ?? null),
      requestedModel: entry.request.model,
      durationMs: entry.durationMs,
      outcome: entry.stop === "hangup" ? "hangup" : response.ok ? "ok" : response.failure,
      usage: response.usage,
      numTurns: result?.num_turns ?? null,
      resultSubtype: result?.subtype ?? null,
      stopReason: result?.stop_reason ?? null,
      terminalReason: result?.terminal_reason ?? null,
      assistantError: observation.assistantError ?? null,
      claudeRequestId: response.claudeRequestId,
      ...(response.ok || response.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: response.retryAfterSeconds }),
      ...(rateLimit === undefined ? {} : { rateLimit: rateLimitSummary(rateLimit) }),
      ...(startupFailureReason === undefined ? {} : { startupFailureReason }),
      // The size only: stderr can carry the prompt or the account's details.
      stderrBytes: entry.stderrBytes,
    };
    // Once a result arrived, a throw is only the CLI's non-zero exit after an error result.
    if (entry.crash !== undefined && result === undefined && entry.stop === undefined) {
      const message = entry.crash instanceof Error ? entry.crash.message : typeof entry.crash;
      logger.warn({ ...fields, crash: message.slice(0, 300) }, "coach run crashed");
      return;
    }
    if (startupFailureReason !== undefined) {
      logger.warn(fields, "coach run failed at startup");
      return;
    }
    logger.info(fields, "coach run finished");
  }

  return {
    run(request, signal) {
      return queue.enqueue(async () => {
        if (closed || signal.aborted) {
          logger.info({ outcome: closed ? "shutdown" : "hangup" }, "coach run skipped");
          return null;
        }
        return execute(request, signal);
      });
    },
    async shutdown() {
      closed = true;
      abortCurrent?.();
      await queue.idle();
    },
  };
}
