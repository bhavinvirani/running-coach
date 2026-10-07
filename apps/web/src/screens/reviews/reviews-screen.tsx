import type { ReviewListItem } from "@running-coach/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { BackLink } from "@/components/back-link";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatWeekRange } from "@/lib/format";
import { reviewCopy } from "@/lib/weekly-review";
import { useReviewsScreen } from "./use-reviews";

/**
 * The coach's weekly reviews at /plan/reviews, newest week first, each as its week's dates and headline,
 * opening the review. Empty until the coach has written one, which happens after the first week ends with
 * a coach credential.
 */
export function ReviewsScreen() {
  const { data, status, error, refetch, refetchError } = useReviewsScreen();

  if (status === "pending") {
    return <ReviewsSkeleton />;
  }

  if (status === "error") {
    return (
      <ReviewsLayout>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </ReviewsLayout>
    );
  }

  const refetchFailed = refetchError ? (
    <RetryAlert error={refetchError} onRetry={() => void refetch()} />
  ) : null;
  const newest = data.reviews[0];

  if (newest === undefined) {
    return (
      <ReviewsLayout>
        {refetchFailed}
        <div className="flex flex-col items-start gap-4">
          <p className="text-body text-ink-2">{reviewCopy.empty}</p>
          <Button asChild>
            <Link to="/plan">{reviewCopy.openPlan}</Link>
          </Button>
        </div>
      </ReviewsLayout>
    );
  }

  return (
    <ReviewsLayout>
      {refetchFailed}
      <ol className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {data.reviews.map((review) => (
          <ReviewRow key={review.id} review={review} newestWeekStart={newest.weekStart} />
        ))}
      </ol>
    </ReviewsLayout>
  );
}

/**
 * One week: its dates as a caption, a year named only for a week outside the newest one's, and the
 * coach's headline, opening the review.
 */
function ReviewRow({
  review,
  newestWeekStart,
}: {
  review: ReviewListItem;
  newestWeekStart: string;
}) {
  const range = formatWeekRange(review.weekStart, newestWeekStart);
  return (
    <li>
      <Link
        to={`/plan/reviews/${review.id}`}
        aria-label={`${range}, ${review.headline}`}
        className="-mx-2 flex min-h-11 flex-col gap-1 rounded-sm px-2 py-3 active:bg-surface-2"
      >
        <span className="text-caption text-ink-2">{range}</span>
        <span className="text-body text-ink">{review.headline}</span>
      </Link>
    </li>
  );
}

/** A detail screen of Plan: Back top left, the title centered. */
function ReviewsLayout({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <header className="relative flex min-h-11 items-center justify-center">
        <BackLink to="/plan" />
        <h1 className="text-title text-ink">{reviewCopy.listTitle}</h1>
      </header>
      {children}
    </div>
  );
}

/** Three rows of a caption and a headline at their loaded heights. */
function ReviewsSkeleton() {
  return (
    <ReviewsLayout busy>
      <div
        role="status"
        aria-label={reviewCopy.loadingList}
        className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4"
      >
        {Array.from({ length: 3 }, (_, position) => (
          <div key={position} className="flex flex-col gap-1 py-3">
            <div className="flex h-4 items-center">
              <div className="h-3 w-16 rounded-sm bg-surface-2" />
            </div>
            <div className="flex h-5.5 items-center">
              <div className="h-4 w-4/5 rounded-sm bg-surface-2" />
            </div>
          </div>
        ))}
      </div>
    </ReviewsLayout>
  );
}
