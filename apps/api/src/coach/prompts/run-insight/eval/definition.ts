import { INSIGHT_MAX_TOKENS } from "../../../client";
import type { CoachEvalDefinition } from "../../../eval";
import { RUN_INSIGHT_PROMPT, RUN_INSIGHT_VERSION } from "../../../run-insight";
import { namesDistanceOrTime, voiceProblems } from "../../../voice";
import {
  buildRunInsightInput,
  type InsightActivity,
  type InsightContext,
  type InsightPlan,
  type InsightSettings,
} from "../input";
import { type RunInsightOutput, runInsightOutputSchema } from "../schema";

// How the eval runner (src/coach/eval.ts) calls run-insight and checks its answer: each case's input goes
// through buildRunInsightInput as the job sends it, and the output must pass the voice and the plan
// change's rules (runInsightOutputProblems).

/** A case's input: what the service would pass in. */
export interface RunInsightEvalInput {
  activity: InsightActivity;
  settings: InsightSettings;
  plan: InsightPlan | null;
  context: InsightContext;
}

const FACTOR_MIN = 0.5;
const FACTOR_MAX = 1.1;

/**
 * What breaks the voice or the plan change's rules in a v2 output, one line per problem: the voice over
 * every text field (adjustment.nextStep included), a factor for scale alone and within 0.5 to 1.1, a
 * next step for a change and none without one, and no distance or time in the change's next step.
 */
export function runInsightOutputProblems(output: RunInsightOutput): string[] {
  const problems = voiceProblems(output, runInsightOutputSchema);
  const { kind, factor, nextStep } = output.adjustment;
  if (kind === "scale") {
    if (factor === null) problems.push("adjustment.factor: missing for scale");
    else if (factor < FACTOR_MIN || factor > FACTOR_MAX) {
      problems.push(`adjustment.factor: ${factor}, outside ${FACTOR_MIN} to ${FACTOR_MAX}`);
    }
  } else if (factor !== null) {
    problems.push(`adjustment.factor: set for ${kind}`);
  }
  if (kind === "none" && nextStep !== null) problems.push("adjustment.nextStep: set for none");
  if (kind !== "none" && nextStep === null)
    problems.push(`adjustment.nextStep: missing for ${kind}`);
  if (nextStep !== null && namesDistanceOrTime(nextStep)) {
    problems.push("adjustment.nextStep: names a distance or time");
  }
  return problems;
}

export const evalDefinition = {
  prompt: RUN_INSIGHT_PROMPT,
  version: RUN_INSIGHT_VERSION,
  schema: runInsightOutputSchema,
  maxTokens: INSIGHT_MAX_TOKENS,
  buildInput: ({ activity, settings, plan, context }: RunInsightEvalInput) =>
    buildRunInsightInput(activity, settings, plan, context),
  outputProblems: runInsightOutputProblems,
} satisfies CoachEvalDefinition<RunInsightEvalInput, typeof runInsightOutputSchema>;
