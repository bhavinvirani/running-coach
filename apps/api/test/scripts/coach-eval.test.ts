import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunInsightInput } from "../../src/coach/prompts/run-insight/input";
import {
  readRunInsightEvalCases,
  RUN_INSIGHT_EVAL_DIR,
  runRunInsightEval,
} from "../../src/coach/run-insight-eval";
import { config } from "../../src/lib/config";
import {
  configureCoachService,
  PLAN_USAGE,
  startFakeCoachService,
  VALID_OUTPUT,
} from "../fake-coach-service";
import { claudeKey, claudeRequests } from "../seed";

// pnpm coach:eval's logic against the fake Claude and a fake coach service, on a temp copy of the eval
// folder: no test needs the network, a real key or the owner's plan, and the committed cases are never
// rewritten by a test.

const coach = await startFakeCoachService();

afterAll(async () => {
  await coach.close();
});

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

    const results = await runRunInsightEval({ credential: { kind: "key", apiKey: key }, dir });

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

    await runRunInsightEval({ credential: { kind: "key", apiKey: claudeKey("valid") }, dir });

    expect(await readRunInsightEvalCases(dir)).toEqual(before);
  });

  it("with write, saves each valid card as its case's output and keeps the input", async () => {
    const before = await readRunInsightEvalCases(dir);

    const results = await runRunInsightEval({
      credential: { kind: "key", apiKey: claudeKey("valid") },
      dir,
      write: true,
    });

    expect(results.every((result) => result.written)).toBe(true);
    const after = await readRunInsightEvalCases(dir);
    expect(after.map(({ evalCase }) => evalCase)).toEqual(
      before.map(({ evalCase }) => ({ input: evalCase.input, output: validOutput })),
    );
  });

  it("with write, reports output that fails its schema and does not write it", async () => {
    const before = await readRunInsightEvalCases(dir);

    const results = await runRunInsightEval({
      credential: { kind: "key", apiKey: claudeKey("schema-invalid") },
      dir,
      write: true,
    });

    expect(results.map((result) => [result.failure, result.written])).toEqual(
      before.map(() => ["invalid_output", false]),
    );
    expect(await readRunInsightEvalCases(dir)).toEqual(before);
  });

  it("reports a rejected key on every case without writing", async () => {
    const results = await runRunInsightEval({
      credential: { kind: "key", apiKey: claudeKey("key-invalid") },
      dir,
      write: true,
    });

    expect(new Set(results.map((result) => result.failure))).toEqual(new Set(["key_invalid"]));
    expect(results.some((result) => result.written)).toBe(false);
  });
});

describe("runRunInsightEval on the Claude plan (--plan)", () => {
  let restore: () => void = () => undefined;

  beforeEach(() => {
    coach.reset();
    restore = configureCoachService(coach);
  });

  afterEach(() => {
    restore();
  });

  it("sends each case's input through the coach service as the job builds it and reports model, usage and both checks", async () => {
    const cases = await readRunInsightEvalCases(dir);

    const results = await runRunInsightEval({ credential: { kind: "plan" }, dir });

    expect(results).toEqual(
      cases.map(({ name }) => ({
        name,
        model: config.COACH_MODEL,
        usage: PLAN_USAGE,
        failure: null,
        voiceProblems: [],
        written: false,
      })),
    );
    expect(coach.runs.map((run) => run.body.input)).toEqual(
      cases.map(({ evalCase: { input } }) =>
        buildRunInsightInput(input.activity, input.settings, input.plan),
      ),
    );
  });

  it("with write, saves each valid card from the plan as its case's output", async () => {
    const before = await readRunInsightEvalCases(dir);

    await runRunInsightEval({ credential: { kind: "plan" }, dir, write: true });

    const after = await readRunInsightEvalCases(dir);
    expect(after.map(({ evalCase }) => evalCase)).toEqual(
      before.map(({ evalCase }) => ({ input: evalCase.input, output: VALID_OUTPUT })),
    );
  });

  it("reports the plan's usage limit on every case without writing (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 600 } });

    const results = await runRunInsightEval({ credential: { kind: "plan" }, dir, write: true });

    expect(new Set(results.map((result) => result.failure))).toEqual(new Set(["plan_limited"]));
    expect(results.some((result) => result.written)).toBe(false);
  });
});

describe("pnpm coach:eval --plan", () => {
  const run = promisify(execFile);
  const tsx = path.join(import.meta.dirname, "../../node_modules/.bin/tsx");
  const script = path.join(import.meta.dirname, "../../src/scripts/coach-eval.ts");

  /** Runs the script with the test environment and these coach service values; never rejects. */
  async function evalScript(coachEnv: Record<string, string>) {
    try {
      const { stdout, stderr } = await run(tsx, [script, "--plan"], {
        env: { ...process.env, ...coachEnv },
        timeout: 15_000,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  }

  it("says which variables to set and exits 1 when the coach service is not set up", async () => {
    const result = await evalScript({ COACH_SERVICE_URL: "", COACH_SERVICE_SECRET: "" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("COACH_SERVICE_URL and COACH_SERVICE_SECRET");
  });

  it("runs every case on the plan through the coach service without a key prompt, and changes no case without --write", async () => {
    coach.reset();
    const before = await readRunInsightEvalCases(RUN_INSIGHT_EVAL_DIR);

    const result = await evalScript({
      COACH_SERVICE_URL: coach.url,
      COACH_SERVICE_SECRET: coach.secret,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Coach service: ${coach.url}`);
    expect(result.stdout).toContain(`${before.length} of ${before.length} cases passed.`);
    expect(result.stdout).not.toContain("Claude API key");
    expect(coach.runs).toHaveLength(before.length);
    expect(await readRunInsightEvalCases(RUN_INSIGHT_EVAL_DIR)).toEqual(before);
  });
});
