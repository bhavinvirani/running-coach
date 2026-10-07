import { useReviews } from "@/api/reviews";
import { screenState } from "@/api/screen-state";

/** Everything the review list reads: the runner's weekly reviews, newest week first. */
export function useReviewsScreen() {
  return screenState(useReviews());
}
