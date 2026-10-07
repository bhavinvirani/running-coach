// What the coach returns for one run, and the shape of the stored card. The one declaration is the
// shared contract (the web reads the same card); coach/client.ts checks its length limits after the
// model answers, because the SDK drops them from the JSON Schema it sends. Since v2 the call's output is
// runInsightOutputSchema, the card plus a proposed change to the next session; the stored card and the
// fallback card stay runInsightSchema, since a change reaches the card only as the engine applied it.

export {
  type CoachAdjustment,
  coachAdjustmentSchema,
  type RunInsight,
  type RunInsightCaution,
  runInsightCautionSchema,
  type RunInsightOutput,
  runInsightOutputSchema,
  runInsightSchema,
} from "@running-coach/shared";
