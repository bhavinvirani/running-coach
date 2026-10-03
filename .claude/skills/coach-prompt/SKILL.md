---
name: coach-prompt
description: Use when adding or versioning a Claude prompt in apps/api/src/coach (run insight, weekly review, race plan), with its schema, fallback, voice rules and eval fixture.
---

# Coach prompt

Copy `apps/api/src/coach/prompts/run-insight/` (`v1.md`, `schema.ts`, `input.ts`, `fallback.ts`, `eval/`), `apps/api/src/coach/run-insight.ts`, `apps/api/src/services/insights.ts` and `apps/api/test/coach/run-insight.test.ts`.

1. `schema.ts`: zod for the output, small and flat (short strings with a `.max()` each, numbers, enums), `.strict()`.
2. `v<N>.md`: role, the voice block and the safety block copied verbatim from run-insight `v1.md`, the output contract in words, one short example.
3. `input.ts`: the user message from the data the service passes in, already in the user's units, language and detail level, numbers through `src/coach/format.ts` (the web formats). No key, no tokens, no email, no other user's data.
4. `fallback.ts`: the card for no key, refusal, `max_tokens`, invalid output, timeout, Claude down, a rejected key or a rejected plan token (`plan_auth_failed`), built from the numbers available without the model, in the output schema's shape; exports `<NAME>_FALLBACK_REASONS`.
5. `<name>.ts`: a version constant (`RUN_INSIGHT_VERSION`); no credential → the fallback card without a call; otherwise `callCoach({ credential, prompt, version, input, schema, maxTokens })`, where the credential is the user's key or the owner's Claude plan; return `{ content, fallback, fallbackReason, usage, model, promptVersion, requestId }`, or `{ limited, retryAfterSeconds }` when the plan's usage limit is reached (never a card: the job waits for the reset). It never touches the database.
6. `src/services/<name>.ts`: reads the rows, resolves the credential (`src/services/coach-credential.ts`; decrypts the key only for a key), calls `<name>.ts`, stores `coach_message` with `prompt_version`, `model` (null for a fallback card) and `usage`, logs Claude's request id with the message id.
7. `eval/`: 3 to 5 cases of input plus recorded output; `eval.test.ts` asserts schema validity and `expect(voiceProblems(card, schema)).toEqual([])` from `src/coach/voice.ts` (no praise or hype words, emoji or closing question, at least one number, every string inside its schema `.max()`) for each recorded output and, through `it.each(<NAME>_FALLBACK_REASONS)`, for the fallback card of every reason, and that the input carries the units and detail level and no key or email.
8. Integration test against the fake Claude (`apps/api/test/fake-claude.ts`; `claudeKey("<fixture>")` from `test/seed.ts` picks `test/fixtures/claude/<fixture>.json`): stored output, timeout without retry, overloaded retried once on the fallback model, rejected key, no key; the plan path against the fake coach service (`apps/api/test/fake-coach-service.ts`): stored output, rejected plan token, usage limit deferred.

A change to a shipped prompt is a new `v<N+1>.md` and a bump of the version constant in `<name>.ts`.
