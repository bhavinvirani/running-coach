// What the coach returns for one week, and the shape of the stored card. The one declaration is the
// shared contract (the web reads the same card); coach/client.ts checks its length limits after the model
// answers, because the SDK drops them from the JSON Schema it sends. The call's output is
// weeklyReviewOutputSchema, the card plus up to REVIEW_CHANGES_MAX changes to the coming week; the stored
// card and the fallback card stay weeklyReviewSchema, since a change reaches the card only as the engine
// applied it.

export {
  REVIEW_CHANGES_MAX,
  type ReviewChangeKind,
  type ReviewChangeProposal,
  reviewChangeProposalSchema,
  type WeeklyReview,
  type WeeklyReviewOutput,
  weeklyReviewOutputSchema,
  weeklyReviewSchema,
} from "@running-coach/shared";
