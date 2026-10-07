import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evalDir,
  evalPrompts,
  loadEvalDefinition,
  readEvalCases,
  runCoachEval,
} from "../../src/coach/eval";
import {
  evalDefinition,
  type RunInsightEvalInput,
} from "../../src/coach/prompts/run-insight/eval/definition";
import { buildRunInsightInput } from "../../src/coach/prompts/run-insight/input";
import { config } from "../../src/lib/config";
import {
  configureCoachService,
  PLAN_USAGE,
  startFakeCoachService,
  VALID_OUTPUT,
} from "../fake-coach-service";
import { claudeKey, claudeRequests } from "../seed";

// pnpm coach:eval's logic against the fake Claude and a fake coach service, on a temp copy of
// run-insight's eval folder: no test needs the network, a real key or the owner's plan, and the committed
// cases are never rewritten by a test.

/** Where the committed run-insight cases sit, the folder the script has always printed. */
const RUN_INSIGHT_CASES = path.join(
  import.meta.dirname,
  "../../src/coach/prompts/run-insight/eval",
);
const readCases = (dir: string) => readEvalCases<RunInsightEvalInput>(dir);

const coach = await startFakeCoachService();

afterAll(async () => {
  await coach.close();
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coach-eval-"));
  await cp(RUN_INSIGHT_CASES, dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runCoachEval", () => {
  it("sends each case's input as the job builds it and reports model, usage and both checks", async () => {
    const key = claudeKey("valid");
    const cases = await readCases(dir);

    const results = await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "key", apiKey: key },
      dir,
    });

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
          content: buildRunInsightInput(input.activity, input.settings, input.plan, input.context),
        },
      ]),
    );
    expect(JSON.stringify(sent)).not.toContain(key);
  });

  it("leaves the cases alone without write", async () => {
    const before = await readCases(dir);

    await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "key", apiKey: claudeKey("valid") },
      dir,
    });

    expect(await readCases(dir)).toEqual(before);
  });

  it("with write, saves each valid card as its case's output and keeps the input", async () => {
    const before = await readCases(dir);

    const results = await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "key", apiKey: claudeKey("valid") },
      dir,
      write: true,
    });

    expect(results.every((result) => result.written)).toBe(true);
    const after = await readCases(dir);
    expect(after.map(({ evalCase }) => evalCase)).toEqual(
      before.map(({ evalCase }) => ({ input: evalCase.input, output: VALID_OUTPUT })),
    );
  });

  it("with write, reports output that fails its schema and does not write it", async () => {
    const before = await readCases(dir);

    const results = await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "key", apiKey: claudeKey("schema-invalid") },
      dir,
      write: true,
    });

    expect(results.map((result) => [result.failure, result.written])).toEqual(
      before.map(() => ["invalid_output", false]),
    );
    expect(await readCases(dir)).toEqual(before);
  });

  it("with write, reports a change outside the prompt's rules (a factor of 0.2) and does not write it", async () => {
    const before = await readCases(dir);

    const results = await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "key", apiKey: claudeKey("adjust-scale-far") },
      dir,
      write: true,
    });

    expect(results.map((result) => [result.failure, result.voiceProblems, result.written])).toEqual(
      before.map(() => [null, ["adjustment.factor: 0.2, outside 0.5 to 1.1"], false]),
    );
    expect(await readCases(dir)).toEqual(before);
  });

  it("builds each input with the definition's own buildInput and reports its own outputProblems, writing nothing they flag", async () => {
    const key = claudeKey("valid");
    const before = await readCases(dir);
    const definition = {
      ...evalDefinition,
      buildInput: (input: RunInsightEvalInput) =>
        `Units: ${input.settings.units}. Plan: ${input.plan === null ? "none" : "active"}.`,
      outputProblems: () => ["flagged by this definition"],
    };

    const results = await runCoachEval({
      definition,
      credential: { kind: "key", apiKey: key },
      dir,
      write: true,
    });

    expect(results.map((result) => [result.failure, result.voiceProblems, result.written])).toEqual(
      before.map(() => [null, ["flagged by this definition"], false]),
    );
    expect((await claudeRequests(key)).map((request) => request.body.messages)).toEqual(
      before.map(({ evalCase: { input } }) => [
        { role: "user", content: definition.buildInput(input) },
      ]),
    );
    expect(await readCases(dir)).toEqual(before);
  });

  it("reports a rejected key on every case without writing", async () => {
    const results = await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "key", apiKey: claudeKey("key-invalid") },
      dir,
      write: true,
    });

    expect(new Set(results.map((result) => result.failure))).toEqual(new Set(["key_invalid"]));
    expect(results.some((result) => result.written)).toBe(false);
  });
});

describe("runCoachEval on the Claude plan (--plan)", () => {
  let restore: () => void = () => undefined;

  beforeEach(() => {
    coach.reset();
    restore = configureCoachService(coach);
  });

  afterEach(() => {
    restore();
  });

  it("sends each case's input through the coach service as the job builds it and reports model, usage and both checks", async () => {
    const cases = await readCases(dir);

    const results = await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "plan" },
      dir,
    });

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
        buildRunInsightInput(input.activity, input.settings, input.plan, input.context),
      ),
    );
  });

  it("with write, saves each valid card from the plan as its case's output", async () => {
    const before = await readCases(dir);

    await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "plan" },
      dir,
      write: true,
    });

    const after = await readCases(dir);
    expect(after.map(({ evalCase }) => evalCase)).toEqual(
      before.map(({ evalCase }) => ({ input: evalCase.input, output: VALID_OUTPUT })),
    );
  });

  it("reports the output of the fixture the test names (a factor of 0.2) and does not write it", async () => {
    coach.use({ run: { kind: "valid", fixture: "adjust-scale-far" } });
    const before = await readCases(dir);

    const results = await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "plan" },
      dir,
      write: true,
    });

    expect(results.map((result) => [result.failure, result.voiceProblems, result.written])).toEqual(
      before.map(() => [null, ["adjustment.factor: 0.2, outside 0.5 to 1.1"], false]),
    );
    expect(await readCases(dir)).toEqual(before);
  });

  it("reports the plan's usage limit on every case without writing (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 600 } });

    const results = await runCoachEval({
      definition: evalDefinition,
      credential: { kind: "plan" },
      dir,
      write: true,
    });

    expect(new Set(results.map((result) => result.failure))).toEqual(new Set(["plan_limited"]));
    expect(results.some((result) => result.written)).toBe(false);
  });
});

describe("loadEvalDefinition", () => {
  it("loads run-insight's evalDefinition from prompts/run-insight/eval/definition.ts", async () => {
    expect(evalDir("run-insight")).toBe(RUN_INSIGHT_CASES);
    expect(await loadEvalDefinition("run-insight")).toBe(evalDefinition);
  });

  it.each([
    [
      "an unknown name",
      "nope",
      'The prompt "nope" has no eval: prompts/nope/eval/definition.ts does not exist.',
    ],
    [
      "a path out of the prompts folder",
      "../x",
      '"../x" is not a prompt name: use lowercase letters, digits and dashes.',
    ],
    [
      "an absolute path",
      "/etc/passwd",
      '"/etc/passwd" is not a prompt name: use lowercase letters, digits and dashes.',
    ],
  ])("rejects %s and names the prompts that have an eval", async (_case, name, reason) => {
    const available = await evalPrompts();

    await expect(loadEvalDefinition(name)).rejects.toThrow(
      `${reason} Pick a prompt with an eval: ${available.join(", ")}.`,
    );
    expect(available).toContain("run-insight");
  });

  it("lists only the prompts with an eval/definition.ts and rejects one whose definition names another prompt", async () => {
    const prompts = path.join(dir, "prompts");
    await mkdir(path.join(prompts, "cases-only/eval"), { recursive: true });
    await writeFile(path.join(prompts, "cases-only/eval/case.json"), "{}\n");
    await mkdir(path.join(prompts, "misnamed/eval"), { recursive: true });
    await writeFile(
      path.join(prompts, "misnamed/eval/definition.ts"),
      'export const evalDefinition = { prompt: "run-insight" };\n',
    );

    expect(await evalPrompts(prompts)).toEqual(["misnamed"]);
    await expect(loadEvalDefinition("cases-only", prompts)).rejects.toThrow(
      "Pick a prompt with an eval: misnamed.",
    );
    await expect(loadEvalDefinition("misnamed", prompts)).rejects.toThrow(
      'prompts/misnamed/eval/definition.ts exports no evalDefinition for "misnamed"',
    );
  });
});

describe("pnpm coach:eval", () => {
  const run = promisify(execFile);
  const tsx = path.join(import.meta.dirname, "../../node_modules/.bin/tsx");
  const script = path.join(import.meta.dirname, "../../src/scripts/coach-eval.ts");

  /** Runs the script with these arguments, the test environment and these values; never rejects. */
  async function evalScript(args: string[], coachEnv: Record<string, string>) {
    try {
      const { stdout, stderr } = await run(tsx, [script, ...args], {
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
    const result = await evalScript(["--plan"], {
      COACH_SERVICE_URL: "",
      COACH_SERVICE_SECRET: "",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("COACH_SERVICE_URL and COACH_SERVICE_SECRET");
  });

  it.each([
    ["an unknown prompt", "nope", 'The prompt "nope" has no eval'],
    ["a path out of the prompts folder", "../x", '"../x" is not a prompt name'],
  ])(
    "exits 1 on %s before the key prompt, naming the prompts that have an eval and printing no Cases line",
    async (_case, name, reason) => {
      const result = await evalScript(["--prompt", name], {});

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(reason);
      expect(result.stderr).toContain("Pick a prompt with an eval: ");
      expect(result.stderr).not.toContain("hidden prompt");
      expect(result.stdout).toBe("");
    },
  );

  it("runs every run-insight case on the plan without a key prompt, prints the same lines with --prompt run-insight as without, and changes no case without --write", async () => {
    coach.reset();
    const before = await readCases(RUN_INSIGHT_CASES);
    const coachEnv = { COACH_SERVICE_URL: coach.url, COACH_SERVICE_SECRET: coach.secret };

    const byDefault = await evalScript(["--plan"], coachEnv);
    const named = await evalScript(["--plan", "--prompt", "run-insight"], coachEnv);

    expect(byDefault.code).toBe(0);
    expect(named).toEqual(byDefault);
    expect(byDefault.stdout).toBe(
      [
        `Cases: ${RUN_INSIGHT_CASES}`,
        `Coach service: ${coach.url}`,
        ...before.flatMap(({ name }) => [
          "",
          name,
          `  model: ${config.COACH_MODEL}  usage: ${PLAN_USAGE.inputTokens} in / ${PLAN_USAGE.outputTokens} out`,
          "  schema: ok  voice: ok",
        ]),
        "",
        `${before.length} of ${before.length} cases passed.`,
        "",
      ].join("\n"),
    );
    expect(coach.runs).toHaveLength(2 * before.length);
    expect(await readCases(RUN_INSIGHT_CASES)).toEqual(before);
  }, 40_000);
});
