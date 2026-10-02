---
name: coach-prompt
description: Use when adding or versioning a Claude prompt in apps/api/src/coach (run insight, weekly review, race plan), with its schema, fallback, voice rules and eval fixture.
---
# Coach prompt

Copy `apps/api/src/coach/prompts/run-insight/` (`v1.md`, `schema.ts`, `input.ts`, `fallback.ts`, `eval/`) and `apps/api/src/coach/run-insight.ts`.

1. `schema.ts`: zod for the output, small and flat (short strings, numbers, enums), `.strict()`.
2. `v<N>.md`: role, the voice block and the safety block copied verbatim from run-insight `v1.md`, the output contract in words, one short example.
3. `input.ts`: the user message from engine and DB data, already in the user's units, language and detail level. No key, no tokens, no email, no other user's data.
4. `fallback.ts`: the card for refusal, `max_tokens`, invalid JSON, timeout or missing key, built from the numbers available without the model.
5. `<name>.ts`: `callCoach({ prompt, version, input, schema })`, store `coach_message` with `prompt_version`, `model` and `usage`, return `{ content, fallback }`.
6. `eval/`: 3 to 5 inputs with recorded outputs; `eval.test.ts` asserts schema validity, no banned openers (`great`, `congrat`, `amazing`, `well done`, any emoji), at least one number, every string inside its `.max(400)`.

A change to a shipped prompt is a new `v<N+1>.md`; the job reads the version from config.
