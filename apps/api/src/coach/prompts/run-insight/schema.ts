// What the coach returns for one run, and the shape of its fallback card. The one declaration is the
// shared contract (the web reads the same card); coach/client.ts checks its length limits after the
// model answers, because the SDK drops them from the JSON Schema it sends.

export {
  type RunInsight,
  type RunInsightCaution,
  runInsightCautionSchema,
  runInsightSchema,
} from "@running-coach/shared";
