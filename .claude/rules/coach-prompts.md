---
paths:
  - "apps/api/src/coach/**"
---

# Coach prompts (apps/api/src/coach)

- One folder per prompt: `prompts/<name>/v<N>.md` (the system prompt, a file, never a string in code), `schema.ts` (zod output schema), `input.ts` (builds the user message from the data the service passes in), `fallback.ts` (the card shown when the model fails). Changing a shipped prompt means a new `v<N+1>.md` and moving the version constant in `<name>.ts` (`RUN_INSIGHT_VERSION`); `coach_message.prompt_version` records which ran (`run-insight/v1`).
- Calls go through `callCoach` in `client.ts` only: `COACH_MODEL` (`claude-opus-5-5`) at low effort, and the one retry goes to `COACH_FALLBACK_MODEL` (`claude-sonnet-5-5`); structured outputs from the zod schema; `max_tokens` `INSIGHT_MAX_TOKENS` 4096 for insights and reviews, `PLAN_MAX_TOKENS` 16384 for plans; the user's decrypted key per call. The API's `metadata` field is not used.
- The coach module never touches the database. `src/services/<name>.ts` reads the rows, decrypts the key, stores the `coach_message` (`prompt_version`, `model`, null for a fallback card, `fallback_reason`, `content`, `usage`) and logs Claude's request id with `coach_message.id`.
- Check `stop_reason` before parsing: `max_tokens` or `refusal` → fallback, any other value but `end_turn` → fallback; then `schema.safeParse`; failure → fallback plus a warning log with the issue paths, never the raw text.
- The prompt input holds numbers already in the user's units and language, written in the web formats through `src/coach/format.ts`, and the `coach_detail` level. It never holds the API key, tokens, email, or another user's data.
- Claude proposes, the engine decides: any plan change in the output is a delta passed to `engine.validateDelta`; a rejected delta drops the change and the text that depends on it.
- Voice, repeated in every system prompt: plain words, short sentences, specific numbers (paces, HR, distances, dates); order is what happened, what it means, what to do next; no hype, emoji, praise openers, filler, rhetorical questions, or questions back to the user.
- Safety, repeated in every system prompt: never recommend load above what the engine allows; never catch up missed sessions; pain, injury, illness or unusual HR mean rest or easy running and seeing a professional; the coach is not medical advice.
- Each prompt has `prompts/<name>/eval/`: 3 to 5 input cases with recorded outputs, checked by `pnpm test` for schema validity and voice with `voiceProblems(card, schema)` from `src/coach/voice.ts` (no banned openers, no emoji, no closing question, at least one number, every string field inside its own `.max()` in `schema.ts`), over the output and the fallback card of each reason in `<NAME>_FALLBACK_REASONS`. A new prompt version reruns the eval against the live API once, by the owner's key, before merge: `pnpm --filter @running-coach/api coach:eval --write` in the owner's terminal reads the key from a hidden prompt and saves the outputs that pass.

Reference (phase 5): `prompts/run-insight/v1.md`, `prompts/run-insight/schema.ts`, `run-insight.ts`, `apps/api/src/services/insights.ts`.
