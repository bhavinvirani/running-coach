---
name: coach-prompt
description: Use when adding or versioning a Claude prompt in apps/api/src/coach (run insight, weekly review, race plan), with its schema, fallback, voice rules and eval fixture.
---

# Coach prompt

Copy `apps/api/src/coach/prompts/run-insight/` (`v1.md`, `schema.ts`, `input.ts`, `fallback.ts`, `eval/`), `apps/api/src/coach/run-insight.ts`, `apps/api/src/services/insights.ts` and `apps/api/test/coach/run-insight.test.ts`.

1. `schema.ts`: zod for the output, small and flat (short strings with a `.max()` each, numbers, enums), `.strict()`.
2. `v<N>.md`: role, the voice block and the safety block copied verbatim from run-insight `v1.md`, the output contract in words, one short example.
3. `input.ts`: the user message from the data the service passes in, already in the user's units, language and detail level. No key, no tokens, no email, no other user's data.
4. `fallback.ts`: the card for no key, refusal, `max_tokens`, invalid output, timeout, Claude down or a rejected key, built from the numbers available without the model, in the output schema's shape.
5. `<name>.ts`: a version constant (`RUN_INSIGHT_VERSION`); no key → the fallback card without a call; otherwise `callCoach({ apiKey, prompt, version, input, schema, maxTokens })`; return `{ content, fallback, fallbackReason, usage, model, promptVersion, requestId }`. It never touches the database.
6. `src/services/<name>.ts`: reads the rows, decrypts the key, calls `<name>.ts`, stores `coach_message` with `prompt_version`, `model` (null for a fallback card) and `usage`, logs Claude's request id with the message id.
7. `eval/`: 3 to 5 cases of input plus recorded output; `eval.test.ts` asserts schema validity and voice (no `great`, `congrat`, `amazing`, `awesome`, `well done` or emoji, no closing question, at least one number, every string inside its schema `.max()`) for the output and for the fallback card, and that the input carries the units and detail level and no key or email.
8. Integration test against the fake Claude (`apps/api/test/fake-claude.ts`; `claudeKey("<fixture>")` from `test/seed.ts` picks `test/fixtures/claude/<fixture>.json`): stored output, timeout without retry, overloaded retried once on the fallback model, rejected key, no key.

A change to a shipped prompt is a new `v<N+1>.md` and a bump of the version constant in `<name>.ts`.
