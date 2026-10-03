---
paths:
  - "apps/coach/**"
---

# Coach service (apps/coach)

- A stateless HTTP service on Render's second free web service that runs one prompt, sent by the API, on the owner's Claude plan through `@anthropic-ai/claude-agent-sdk` (pinned exactly; Dependabot gives it its own PR and never auto-merges it). The API owns prompts, schemas, fallbacks, users and the database; this service never sees a user, a key or a row, and imports only `packages/shared`.
- Routes (`src/server.ts`, node:http; 127.0.0.1 except in production): `GET /health` without a secret; `POST /v1/run` with `x-coach-secret` compared as SHA-256 digests with `timingSafeEqual` (401 before anything spawns), body and answer from `packages/shared/src/contracts/coach-service.ts`. Claude's failures are 200 `{ ok: false, failure }`; the service's own errors are problem+json.
- The plan token (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`) is read in `src/config.ts` only and goes to Claude Code's `env` only: never a log, a response, another HTTP call or the Messages API. That `env` replaces the child's environment and is built from an allowlist (`childEnv` in `src/run.ts`: the token, `CLAUDE_CODE_MAX_RETRIES=2`, the output cap, `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` so a startup failure names its reason, no-telemetry flags, PATH, HOME, TMPDIR, LANG); never inherit `process.env`, since an `ANTHROPIC_API_KEY` there would win over the token. Production refuses to boot without the token; development without one uses the laptop's Claude Code login.
- Every run: `tools: []`, `settingSources: []`, `persistSession: false`, no MCP servers, low effort, json_schema output, `fallbackModel`, `maxTurns` 4, an empty temp cwd. One Claude Code process at a time (200 to 250 MB each): a FIFO queue, the next run waits for the CLI's exit (`'exit'`, never the abort's `'error'`; SIGKILL 3 s after an abort), and a run is aborted after `COACH_RUN_TIMEOUT_MS` or when the API hangs up.
- Outcomes (`src/outcome.ts`): only a success result with `is_error` false and a `structured_output` is ok. Claude Code ends an API error with a success result whose `is_error` is true, classified by the assistant frame's `error`; a rejected `rate_limit_event` is `plan_limited` with `resetsAt` (Unix seconds).
- Logs: request id, model, duration, outcome, usage, turns, rate-limit status and utilization; never the token, prompt, input or output, and CLI stderr only by size.
- Tests run the real SDK against `test/fake-claude-code.mjs` (`CLAUDE_CODE_EXECUTABLE`), which speaks stream-json, picks its scenario from the fake token `test-<scenario>.<nonce>` and records its argv and env names for the allowlist tests.
