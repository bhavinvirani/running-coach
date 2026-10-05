import type { z } from "zod";

/**
 * Deletes, in place, every key an unrecognized_keys issue names. False when any issue is something else: the
 * body then differs from the contract in a way that dropping keys cannot fix.
 */
function dropUnknownKeys(body: unknown, issues: readonly z.core.$ZodIssue[]): boolean {
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") return false;
    let node = body;
    for (const key of issue.path) node = (node as Record<PropertyKey, unknown> | null)?.[key];
    if (typeof node !== "object" || node === null) return false;
    for (const key of issue.keys) delete (node as Record<string, unknown>)[key];
  }
  return true;
}

/**
 * Reads a response with the strict shared schema, dropping keys it does not declare: an installed app runs
 * the previous version for a while after a deploy, so a field the API added must not break it. The API keeps
 * the schemas strict (respond()), so this is the web app's tolerance alone. Anything else outside the
 * contract (a missing key, a changed type, an enum value or union member this version does not know) still
 * fails. The last parse is always the strict schema itself, so a body on the contract reads exactly as
 * before, and a union that cannot tell which member an unknown key belongs to fails instead of guessing.
 * Mutates `body`, the caller's freshly parsed JSON.
 */
export function parseResponse<T>(schema: z.ZodType<T>, body: unknown): z.ZodSafeParseResult<T> {
  let result = schema.safeParse(body);
  // zod reports every unknown key in one parse (unrecognized_keys never aborts); the second pass covers a
  // union that, with the keys gone, picks another member.
  for (let pass = 0; pass < 2 && !result.success; pass += 1) {
    if (!dropUnknownKeys(body, result.error.issues)) break;
    result = schema.safeParse(body);
  }
  return result;
}
