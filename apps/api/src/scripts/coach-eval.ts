// pnpm coach:eval [--plan] [--write]: runs every run-insight eval case against the live Claude API, once
// per prompt version before merge (coach-prompts rule). With the owner's key by default: typed at a
// hidden prompt, used for these calls and forgotten, never an argument, an env var, a log line or a file.
// With --plan on the owner's Claude plan instead, through the coach service named by COACH_SERVICE_URL
// and COACH_SERVICE_SECRET; the plan's token stays in that service. Prints each case's model, usage,
// schema check and voice check; --write saves every card that passes both as the case's recorded
// output, for `pnpm test` to check from then on.
import { parseArgs } from "node:util";
import type { CoachCallCredential } from "../coach/client";
import { RUN_INSIGHT_EVAL_DIR, runRunInsightEval } from "../coach/run-insight-eval";
import { coachServiceOf, config } from "../lib/config";
import { safeErrorMessage } from "../lib/logger";

const { values } = parseArgs({
  options: {
    write: { type: "boolean", default: false },
    plan: { type: "boolean", default: false },
  },
});

/** Reads one line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (done: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      done();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value.trim()));
        // Ctrl-C and Ctrl-D
        if (char === "\u0003" || char === "\u0004") {
          return finish(() => reject(new Error("Cancelled.")));
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

const coachService = coachServiceOf(config);
if (values.plan && !coachService) {
  console.error(
    "coach:eval --plan runs on the coach service: set COACH_SERVICE_URL and COACH_SERVICE_SECRET (at least 32 characters, the same as the service's) and run again.",
  );
  process.exit(1);
}
if (!values.plan && !process.stdin.isTTY) {
  console.error(
    "coach:eval reads the Claude key from a hidden prompt, so run it in a terminal, not with piped input.",
  );
  process.exit(1);
}

/** The plan through the coach service, or the key typed at the hidden prompt. */
async function credentialFromArgs(): Promise<CoachCallCredential> {
  if (coachService && values.plan) {
    console.log(`Coach service: ${coachService.url}`);
    return { kind: "plan" };
  }
  console.log(`Claude: ${config.CLAUDE_BASE_URL ?? "https://api.anthropic.com"}`);
  const apiKey = await readHidden("Claude API key (not shown): ");
  if (!apiKey) throw new Error("No key typed.");
  return { kind: "key", apiKey };
}

try {
  console.log(`Cases: ${RUN_INSIGHT_EVAL_DIR}`);
  const credential = await credentialFromArgs();

  const results = await runRunInsightEval({ credential, write: values.write });
  for (const result of results) {
    const usage = result.usage
      ? `${result.usage.inputTokens} in / ${result.usage.outputTokens} out`
      : "none";
    const schema = result.failure ? `failed (${result.failure})` : "ok";
    const voice = result.failure
      ? "-"
      : result.voiceProblems.length === 0
        ? "ok"
        : result.voiceProblems.join("; ");
    console.log(`\n${result.name}`);
    console.log(`  model: ${result.model ?? "-"}  usage: ${usage}`);
    console.log(`  schema: ${schema}  voice: ${voice}`);
    if (values.write) console.log(`  ${result.written ? "written" : "not written"}`);
  }
  const passed = results.filter((result) => !result.failure && result.voiceProblems.length === 0);
  console.log(`\n${passed.length} of ${results.length} cases passed.`);
  if (passed.length < results.length) process.exitCode = 1;
} catch (err) {
  console.error("The eval failed:", safeErrorMessage(err));
  process.exitCode = 1;
}
