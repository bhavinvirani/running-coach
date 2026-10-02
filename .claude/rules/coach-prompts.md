---
paths:
  - "apps/api/src/coach/**"
---
# Coach prompts (apps/api/src/coach)

- One folder per prompt: `prompts/<name>/v<N>.md` (the system prompt, a file, never a string in code), `schema.ts` (zod output schema), `input.ts` (builds the user message from engine and DB data), `fallback.ts` (the card shown when the model fails). Changing a shipped prompt means a new `v<N+1>.md`; `coach_message.prompt_version` records which ran.
- Calls go through `client.ts` only: model from config (`claude-opus-5-5` at low effort, `claude-sonnet-5-5` as fallback), structured outputs from the zod schema, `max_tokens` 4096 for insights and reviews and 16384 for plans, the user's decrypted key per call, usage saved to `coach_message.usage`. The request id is logged with `coach_message.id`; the API's `metadata` field is not used.
- Check `stop_reason` before parsing: `max_tokens` or `refusal` → fallback; then `schema.safeParse`; failure → fallback plus a warning log with the issue paths, never the raw text.
- The prompt input holds numbers already in the user's units and language and the `coach_detail` level. It never holds the API key, tokens, email, or another user's data.
- Claude proposes, the engine decides: any plan change in the output is a delta passed to `engine.validateDelta`; a rejected delta drops the change and the text that depends on it.
- Voice, repeated in every system prompt: plain words, short sentences, specific numbers (paces, HR, distances, dates); order is what happened, what it means, what to do next; no hype, emoji, praise openers, filler, rhetorical questions, or questions back to the user.
- Safety, repeated in every system prompt: never recommend load above what the engine allows; never catch up missed sessions; pain, injury, illness or unusual HR mean rest or easy running and seeing a professional; the coach is not medical advice.
- Each prompt has `prompts/<name>/eval/`: 3 to 5 input cases with recorded outputs, checked by `pnpm test` for schema validity and voice (no banned openers, at least one number, every string field inside its `.max(400)` from `schema.ts`). A new prompt version reruns the eval against the live API once, by the owner's key, before merge.

Reference (phase 5): `prompts/run-insight/v1.md`, `prompts/run-insight/schema.ts`, `run-insight.ts`.
