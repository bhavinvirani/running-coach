import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { paths } from "../lib/paths";
import { type CoachCallCredential, callCoach, type CoachFailure, type CoachUsage } from "./client";

// The eval of any coach prompt against the live API, on a key or on the owner's Claude plan through the
// coach service (pnpm coach:eval --prompt <name> [--plan], src/scripts/coach-eval.ts). Each prompt says
// in prompts/<name>/eval/definition.ts how a case's input becomes the user message and what its output
// must pass beyond the schema. Every case's input goes through callCoach exactly as the job sends it, and
// the answer is checked for its schema (callCoach parses it) and the definition's outputProblems. With
// write, an answer that passes both becomes the case's recorded output, which the prompt's eval.test.ts
// then checks on every `pnpm test`. The definition is imported by name rather than listed in a registry,
// so a new prompt adds its own folder and edits nothing here.

/** One eval case file: what the service would pass in, and the output recorded for it. */
export interface CoachEvalCase<I> {
  input: I;
  output: unknown;
}

/**
 * What a prompt's eval/definition.ts exports as evalDefinition. Its functions are properties, not methods,
 * so `satisfies` rejects one that does not fit the definition's own input or schema.
 */
export interface CoachEvalDefinition<I, S extends z.ZodType> {
  /** The folder under src/coach/prompts, also the script's --prompt name. */
  prompt: string;
  /** The prompt's version constant in use (RUN_INSIGHT_VERSION). */
  version: string;
  schema: S;
  maxTokens: number;
  /** The user message for a case's input, as the job builds it. */
  buildInput: (input: I) => string;
  /** What breaks the voice or the prompt's own rules in a parsed output, one line per problem. */
  outputProblems: (output: z.output<S>) => string[];
}

/** A definition as the script loads it, before anything is known about its input or schema. */
export type LoadedCoachEvalDefinition = CoachEvalDefinition<unknown, z.ZodType>;

export interface CoachEvalResult {
  name: string;
  /** The model that answered, or null when none did usably. */
  model: string | null;
  usage: CoachUsage | null;
  /** Why there is no output: invalid_output covers a broken schema; null when the output parsed. */
  failure: CoachFailure | null;
  /** The definition's checks on the output; empty when they pass or there is no output. */
  voiceProblems: string[];
  /** True when the output passed both checks and was saved as the case's output. */
  written: boolean;
}

// A prompt name is a folder name, so "../x" or an absolute path never reaches the file system.
const PROMPT_NAME = /^[a-z0-9-]+$/;

/** The folder holding a prompt's eval cases and definition. */
export function evalDir(prompt: string, promptsDir: string = paths.prompts): string {
  return path.join(promptsDir, prompt, "eval");
}

function definitionFile(prompt: string, promptsDir: string): string {
  return path.join(evalDir(prompt, promptsDir), "definition.ts");
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The prompts that have an eval/definition.ts, in name order. */
export async function evalPrompts(promptsDir: string = paths.prompts): Promise<string[]> {
  const folders = (await readdir(promptsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && PROMPT_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const withEval = await Promise.all(
    folders.map(async (name) => ((await isFile(definitionFile(name, promptsDir))) ? name : null)),
  );
  return withEval.filter((name) => name !== null);
}

/**
 * The evalDefinition exported by prompts/<name>/eval/definition.ts. Throws, naming the prompts that have
 * an eval, when the name is not a folder name, the file is missing or it exports no definition for name.
 */
export async function loadEvalDefinition(
  name: string,
  promptsDir: string = paths.prompts,
): Promise<LoadedCoachEvalDefinition> {
  const pick = async () =>
    `Pick a prompt with an eval: ${(await evalPrompts(promptsDir)).join(", ") || "none yet"}.`;
  if (!PROMPT_NAME.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a prompt name: use lowercase letters, digits and dashes. ${await pick()}`,
    );
  }
  const file = definitionFile(name, promptsDir);
  if (!(await isFile(file))) {
    throw new Error(
      `The prompt "${name}" has no eval: prompts/${name}/eval/definition.ts does not exist. ${await pick()}`,
    );
  }
  const { evalDefinition } = (await import(pathToFileURL(file).href)) as {
    evalDefinition?: Partial<LoadedCoachEvalDefinition>;
  };
  if (evalDefinition?.prompt !== name) {
    throw new Error(
      `prompts/${name}/eval/definition.ts exports no evalDefinition for "${name}": export one whose prompt is "${name}".`,
    );
  }
  return evalDefinition as LoadedCoachEvalDefinition;
}

/** Every case in dir, in file name order. */
export async function readEvalCases<I>(
  dir: string,
): Promise<{ name: string; file: string; evalCase: CoachEvalCase<I> }[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => ({
      name: path.basename(file, ".json"),
      file: path.join(dir, file),
      evalCase: JSON.parse(await readFile(path.join(dir, file), "utf8")) as CoachEvalCase<I>,
    })),
  );
}

/** Runs each case once, one after another so a rate limit hits one case, not all of them. */
export async function runCoachEval<I, S extends z.ZodType>({
  definition,
  credential,
  dir = evalDir(definition.prompt),
  write = false,
}: {
  definition: CoachEvalDefinition<I, S>;
  /** A key used for these calls only, never logged or stored, or the plan through the coach service. */
  credential: CoachCallCredential;
  dir?: string;
  write?: boolean;
}): Promise<CoachEvalResult[]> {
  const results: CoachEvalResult[] = [];
  for (const { name, file, evalCase } of await readEvalCases<I>(dir)) {
    const result = await callCoach({
      credential,
      prompt: definition.prompt,
      version: definition.version,
      input: definition.buildInput(evalCase.input),
      schema: definition.schema,
      maxTokens: definition.maxTokens,
    });
    if (!result.ok) {
      results.push({
        name,
        model: null,
        usage: result.usage,
        failure: result.failure,
        voiceProblems: [],
        written: false,
      });
      continue;
    }
    const problems = definition.outputProblems(result.output);
    const written = write && problems.length === 0;
    if (written) {
      const updated: CoachEvalCase<I> = { input: evalCase.input, output: result.output };
      await writeFile(file, `${JSON.stringify(updated, null, 2)}\n`);
    }
    results.push({
      name,
      model: result.model,
      usage: result.usage,
      failure: null,
      voiceProblems: problems,
      written,
    });
  }
  return results;
}
