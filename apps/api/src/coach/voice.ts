import { z } from "zod";

// The coach's voice (coach-prompts rule) as checks every prompt's eval runs on its recorded outputs and
// its fallback cards: no praise or hype words, no emoji, no closing question, at least one number, and
// every string field inside its schema's .max(), nested objects (run-insight's adjustment) and nullable
// strings included.

const PRAISE = /\b(great|congrat\w*|amazing|awesome|well done)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const DIGIT = /\d/;

type Shape = Record<string, z.ZodType>;

/** The schema under a nullable or optional wrapper. */
function unwrapped(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
    return unwrapped(schema.unwrap() as z.ZodType);
  }
  return schema;
}

function checkFields(
  value: Record<string, unknown>,
  shape: Shape,
  prefix: string,
  problems: string[],
  texts: string[],
): void {
  for (const [key, declared] of Object.entries(shape)) {
    const field = `${prefix}${key}`;
    const fieldSchema = unwrapped(declared);
    const fieldValue = value[key];
    if (fieldSchema instanceof z.ZodObject) {
      if (typeof fieldValue === "object" && fieldValue !== null) {
        checkFields(
          fieldValue as Record<string, unknown>,
          fieldSchema.shape,
          `${field}.`,
          problems,
          texts,
        );
      }
      continue;
    }
    if (!(fieldSchema instanceof z.ZodString) || typeof fieldValue !== "string") continue;
    texts.push(fieldValue);
    if (PRAISE.test(fieldValue)) problems.push(`${field}: praise or hype word`);
    if (EMOJI.test(fieldValue)) problems.push(`${field}: emoji`);
    if (fieldValue.trim().endsWith("?")) problems.push(`${field}: ends with a question`);
    const max = fieldSchema.maxLength;
    if (max === null) problems.push(`${field}: the schema has no .max()`);
    else if (fieldValue.length > max) {
      problems.push(`${field}: ${fieldValue.length} characters, max ${max}`);
    }
  }
}

/** What breaks the voice in a card, one line per problem; empty when the card is fine. */
export function voiceProblems(card: Record<string, unknown>, schema: { shape: Shape }): string[] {
  const problems: string[] = [];
  const texts: string[] = [];
  checkFields(card, schema.shape, "", problems, texts);
  if (!texts.some((text) => DIGIT.test(text))) problems.push("no number in any field");
  return problems;
}
