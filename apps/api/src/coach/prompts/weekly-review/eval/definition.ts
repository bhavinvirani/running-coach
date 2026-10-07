import { INSIGHT_MAX_TOKENS } from "../../../client";
import type { CoachEvalDefinition } from "../../../eval";
import { namesDistanceOrTime, voiceProblems } from "../../../voice";
import { WEEKLY_REVIEW_PROMPT, WEEKLY_REVIEW_VERSION } from "../../../weekly-review";
import {
  buildWeeklyReviewInput,
  type ReviewPlan,
  type ReviewSettings,
  type ReviewWeek,
} from "../input";
import { type WeeklyReviewOutput, weeklyReviewOutputSchema } from "../schema";

// How the eval runner (src/coach/eval.ts) calls weekly-review and checks its answer: each case's input goes
// through buildWeeklyReviewInput as the job sends it, and the output must pass the voice and the changes'
// own rules (weeklyReviewOutputProblems). The rules that depend on the input (no change when none is
// allowed, only to a session that may change, no rise after a paused week) are in eval.test.ts.

/** A case's input: what the service would pass in. */
export interface WeeklyReviewEvalInput {
  week: ReviewWeek;
  plan: ReviewPlan | null;
  settings: ReviewSettings;
}

const FACTOR_MIN = 0.5;
const FACTOR_MAX = 1.1;

/**
 * What breaks the voice or the changes' rules in a v1 output, one line per problem: the voice over every
 * text field (each change's note included), one change per session, a factor for scale alone and within
 * 0.5 to 1.1, and no distance or time in a change's note.
 */
export function weeklyReviewOutputProblems(output: WeeklyReviewOutput): string[] {
  const problems = voiceProblems(output, weeklyReviewOutputSchema);
  const named = new Set<string>();
  output.changes.forEach(({ session, kind, factor, note }, index) => {
    const at = `changes[${index}]`;
    if (named.has(session)) problems.push(`${at}.session: ${session} named twice`);
    named.add(session);
    if (kind === "scale") {
      if (factor === null) problems.push(`${at}.factor: missing for scale`);
      else if (factor < FACTOR_MIN || factor > FACTOR_MAX) {
        problems.push(`${at}.factor: ${factor}, outside ${FACTOR_MIN} to ${FACTOR_MAX}`);
      }
    } else if (factor !== null) {
      problems.push(`${at}.factor: set for ${kind}`);
    }
    if (namesDistanceOrTime(note)) problems.push(`${at}.note: names a distance or time`);
  });
  return problems;
}

export const evalDefinition = {
  prompt: WEEKLY_REVIEW_PROMPT,
  version: WEEKLY_REVIEW_VERSION,
  schema: weeklyReviewOutputSchema,
  maxTokens: INSIGHT_MAX_TOKENS,
  buildInput: ({ week, plan, settings }: WeeklyReviewEvalInput) =>
    buildWeeklyReviewInput(week, plan, settings),
  outputProblems: weeklyReviewOutputProblems,
} satisfies CoachEvalDefinition<WeeklyReviewEvalInput, typeof weeklyReviewOutputSchema>;
