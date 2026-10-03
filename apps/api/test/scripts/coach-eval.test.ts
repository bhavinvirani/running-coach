import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunInsightInput } from "../../src/coach/prompts/run-insight/input";
import {
  readRunInsightEvalCases,
  RUN_INSIGHT_EVAL_DIR,
  runRunInsightEval,
} from "../../src/coach/run-insight-eval";
import { config } from "../../src/lib/config";
import { claudeKey, claudeRequests } from "../seed";

// pnpm coach:eval's logic against the fake Claude, on a temp copy of the eval folder: no test needs the
// network or a real key, and the committed cases are never rewritten by a test.

const validFixture = JSON.parse(
  await readFile(path.join(import.meta.dirname, "../fixtures/claude/valid.json"), "utf8"),
) as { responses: [{ body: { content: [{ json: unknown }] } }] };
const validOutput = validFixture.responses[0].body.content[0].json;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coach-eval-"));
  await cp(RUN_INSIGHT_EVAL_DIR, dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runRunInsightEval", () => {
  it("sends each case's input as the job builds it and reports model, usage and both checks", async () => {
    const key = claudeKey("valid");
    const cases = await readRunInsightEvalCases(dir);

    const results = await runRunInsightEval({ apiKey: key, dir });

    expect(results).toEqual(
      cases.map(({ name }) => ({
        name,
        model: config.COACH_MODEL,
        usage: { inputTokens: 1180, outputTokens: 164 },
        failure: null,
        voiceProblems: [],
        written: false,
      })),
    );
    const sent = (await claudeRequests(key)).map((request) => request.body.messages);
    expect(sent).toEqual(
      cases.map(({ evalCase: { input } }) => [
        {
          role: "user",
          content: buildRunInsightInput(input.activity, input.settings, input.plan),
        },
      ]),
    );
    expect(JSON.stringify(sent)).not.toContain(key);
  });

  it("leaves the cases alone without write", async () => {
    const before = await readRunInsightEvalCases(dir);

    await runRunInsightEval({ apiKey: claudeKey("valid"), dir });

    expect(await readRunInsightEvalCases(dir)).toEqual(before);
  });

  it("with write, saves each valid card as its case's output and keeps the input", async () => {
    const before = await readRunInsightEvalCases(dir);

    const results = await runRunInsightEval({ apiKey: claudeKey("valid"), dir, write: true });

    expect(results.every((result) => result.written)).toBe(true);
    const after = await readRunInsightEvalCases(dir);
    expect(after.map(({ evalCase }) => evalCase)).toEqual(
      before.map(({ evalCase }) => ({ input: evalCase.input, output: validOutput })),
    );
  });

  it("with write, reports output that fails its schema and does not write it", async () => {
    const before = await readRunInsightEvalCases(dir);

    const results = await runRunInsightEval({
      apiKey: claudeKey("schema-invalid"),
      dir,
      write: true,
    });

    expect(results.map((result) => [result.failure, result.written])).toEqual(
      before.map(() => ["invalid_output", false]),
    );
    expect(await readRunInsightEvalCases(dir)).toEqual(before);
  });

  it("reports a rejected key on every case without writing", async () => {
    const results = await runRunInsightEval({ apiKey: claudeKey("key-invalid"), dir, write: true });

    expect(new Set(results.map((result) => result.failure))).toEqual(new Set(["key_invalid"]));
    expect(results.some((result) => result.written)).toBe(false);
  });
});
