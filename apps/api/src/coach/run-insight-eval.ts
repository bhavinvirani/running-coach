import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CoachCallCredential,
  callCoach,
  type CoachFailure,
  type CoachUsage,
  INSIGHT_MAX_TOKENS,
} from "./client";
import {
  buildRunInsightInput,
  type InsightActivity,
  type InsightPlan,
  type InsightSettings,
} from "./prompts/run-insight/input";
import { runInsightSchema } from "./prompts/run-insight/schema";
import { RUN_INSIGHT_PROMPT, RUN_INSIGHT_VERSION } from "./run-insight";
import { voiceProblems } from "./voice";

// The run-insight eval against the live API, on a key or on the owner's Claude plan through the coach
// service (pnpm coach:eval [--plan], src/scripts/coach-eval.ts): every case's input goes through
// callCoach exactly as the job sends it, and the answer is checked for its schema (callCoach parses it)
// and the voice. With write, an answer that passes both becomes the case's
// recorded output, which eval.test.ts then checks on every `pnpm test`.

export const RUN_INSIGHT_EVAL_DIR = path.join(import.meta.dirname, "prompts/run-insight/eval");

/** One eval case file: what the service would pass in, and the card recorded for it. */
export interface RunInsightEvalCase {
  input: { activity: InsightActivity; settings: InsightSettings; plan: InsightPlan | null };
  output: unknown;
}

export interface RunInsightEvalResult {
  name: string;
  /** The model that answered, or null when none did usably. */
  model: string | null;
  usage: CoachUsage | null;
  /** Why there is no card: invalid_output covers a broken schema; null when the card parsed. */
  failure: CoachFailure | null;
  /** The voice check on the card; empty when it passes or there is no card. */
  voiceProblems: string[];
  /** True when the card passed both checks and was saved as the case's output. */
  written: boolean;
}

/** Every case in dir, in file name order. */
export async function readRunInsightEvalCases(
  dir: string,
): Promise<{ name: string; file: string; evalCase: RunInsightEvalCase }[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => ({
      name: path.basename(file, ".json"),
      file: path.join(dir, file),
      evalCase: JSON.parse(await readFile(path.join(dir, file), "utf8")) as RunInsightEvalCase,
    })),
  );
}

/** Runs each case once, one after another so a rate limit hits one case, not all of them. */
export async function runRunInsightEval({
  credential,
  dir = RUN_INSIGHT_EVAL_DIR,
  write = false,
}: {
  /** A key used for these calls only, never logged or stored, or the plan through the coach service. */
  credential: CoachCallCredential;
  dir?: string;
  write?: boolean;
}): Promise<RunInsightEvalResult[]> {
  const results: RunInsightEvalResult[] = [];
  for (const { name, file, evalCase } of await readRunInsightEvalCases(dir)) {
    const { activity, settings, plan } = evalCase.input;
    const result = await callCoach({
      credential,
      prompt: RUN_INSIGHT_PROMPT,
      version: RUN_INSIGHT_VERSION,
      input: buildRunInsightInput(activity, settings, plan),
      schema: runInsightSchema,
      maxTokens: INSIGHT_MAX_TOKENS,
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
    const problems = voiceProblems(result.output, runInsightSchema);
    const written = write && problems.length === 0;
    if (written) {
      const updated: RunInsightEvalCase = { input: evalCase.input, output: result.output };
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
