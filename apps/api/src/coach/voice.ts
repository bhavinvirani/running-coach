import { z } from "zod";

// The coach's voice (coach-prompts rule) as checks every prompt's eval runs on its recorded outputs and
// its fallback cards: no praise or hype words, no emoji, no closing question, at least one number, and
// every string field inside its schema's .max().

const PRAISE = /\b(great|congrat\w*|amazing|awesome|well done)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const DIGIT = /\d/;

/** What breaks the voice in a card, one line per problem; empty when the card is fine. */
export function voiceProblems(
  card: Record<string, unknown>,
  schema: { shape: Record<string, z.ZodType> },
): string[] {
  const problems: string[] = [];
  const texts: string[] = [];
  for (const [field, fieldSchema] of Object.entries(schema.shape)) {
    const value = card[field];
    if (!(fieldSchema instanceof z.ZodString) || typeof value !== "string") continue;
    texts.push(value);
    if (PRAISE.test(value)) problems.push(`${field}: praise or hype word`);
    if (EMOJI.test(value)) problems.push(`${field}: emoji`);
    if (value.trim().endsWith("?")) problems.push(`${field}: ends with a question`);
    const max = fieldSchema.maxLength;
    if (max === null) problems.push(`${field}: the schema has no .max()`);
    else if (value.length > max) problems.push(`${field}: ${value.length} characters, max ${max}`);
  }
  if (!texts.some((text) => DIGIT.test(text))) problems.push("no number in any field");
  return problems;
}
