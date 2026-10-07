import { z } from "zod";

// The coach's voice (coach-prompts rule) as checks every prompt's eval runs on its recorded outputs and
// its fallback cards: no praise or hype words, no emoji, no closing question, at least one number, and
// every string field inside its schema's .max(), nested objects (run-insight's adjustment), lists of
// objects (weekly-review's changes) and nullable strings included.

const PRAISE = /\b(great|congrat\w*|amazing|awesome|well done)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const DIGIT = /\d/;
// A distance or a time: a change's own text must leave them out, since the app shows the engine's numbers,
// which may differ from the coach's after clamping.
const DISTANCE_OR_TIME =
  /\b\d+(?:[.,]\d+)?\s?(?:km|kilomet(?:er|re)s?|mi|miles?|m|met(?:er|re)s?|min|minutes?|h|hours?)\b|\b\d{1,2}:\d{2}\b/i;

/** Whether the text names a distance or a time ("6.4 km", "4 miles", "30 minutes", "36:00"). */
export function namesDistanceOrTime(text: string): boolean {
  return DISTANCE_OR_TIME.test(text);
}

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
    if (fieldSchema instanceof z.ZodArray) {
      const element = unwrapped(fieldSchema.element as z.ZodType);
      if (element instanceof z.ZodObject && Array.isArray(fieldValue)) {
        fieldValue.forEach((item: unknown, index) => {
          if (typeof item === "object" && item !== null) {
            const at = `${field}[${index}].`;
            checkFields(item as Record<string, unknown>, element.shape, at, problems, texts);
          }
        });
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
