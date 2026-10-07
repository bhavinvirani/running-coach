import type { CoachFeedback } from "@running-coach/shared";
import { useSettings } from "@/api/me";
import { useReview, useReviewFeedback } from "@/api/reviews";
import { screenState } from "@/api/screen-state";
import { today } from "@/lib/dates";

/**
 * Everything a weekly review reads and does: the review with its coming week as it stands now, the units
 * and today in the runner's time zone from /api/me, which the authenticated loader caches, and thumbs.
 */
export function useReviewScreen(id: string) {
  const review = useReview(id);
  const settings = useSettings();
  const feedback = useReviewFeedback();

  return {
    ...screenState(review),
    units: settings.data?.units,
    today: settings.data === undefined ? undefined : today(settings.data.timezone),
    feedbackError: feedback.error,
    setFeedback: (reviewId: string, value: CoachFeedback | null) =>
      feedback.mutate({ reviewId, feedback: value }),
  };
}
