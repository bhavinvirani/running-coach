import { ErrorCode } from "@running-coach/shared";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { isApiError } from "@/api/client";
import { BackLink } from "@/components/back-link";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { WeeklyReviewCard } from "@/components/weekly-review-card";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { reviewCopy } from "@/lib/weekly-review";
import { useReviewScreen } from "./use-review";

/**
 * One weekly review at /plan/reviews/:id: the card as Today shows it, with thumbs, then the coming week's
 * sessions as they stand now, each opening its session. Keyed by id, so another review starts over.
 */
export function ReviewScreen() {
  const { id = "" } = useParams();
  return <ReviewView key={id} id={id} />;
}

/**
 * Loading, error and content only. No empty state: the API answers with a review or with 404, which is a
 * review that is not the runner's or an address that names none, shown as gone with the way to the list.
 */
function ReviewView({ id }: { id: string }) {
  const screen = useReviewScreen(id);
  const { data, status, error, refetch, units, today } = screen;

  if (status === "pending" || units === undefined || today === undefined) {
    return <ReviewSkeleton />;
  }

  if (status === "error") {
    if (isApiError(error) && error.code === ErrorCode.notFound) {
      return (
        <ReviewLayout>
          <div className="flex flex-col items-start gap-4">
            <p role="alert" className="text-body text-ink">
              {errorMessage(error)}
            </p>
            <Button asChild>
              <Link to="/plan/reviews">{reviewCopy.openList}</Link>
            </Button>
          </div>
        </ReviewLayout>
      );
    }
    return (
      <ReviewLayout>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </ReviewLayout>
    );
  }

  return (
    <ReviewLayout>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <WeeklyReviewCard
        review={data.review}
        units={units}
        today={today}
        setFeedback={screen.setFeedback}
        feedbackError={screen.feedbackError}
        comingWeek
      />
    </ReviewLayout>
  );
}

/** A detail screen: Back top left to the list, the title centered. */
function ReviewLayout({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <header className="relative flex min-h-11 items-center justify-center">
        <BackLink to="/plan/reviews" />
        <h1 className="text-title text-ink">{reviewCopy.title}</h1>
      </header>
      {children}
    </div>
  );
}

/** The dates, the card's headline, stats and three parts, and the coming week at their loaded heights. */
function ReviewSkeleton() {
  return (
    <ReviewLayout busy>
      <div role="status" aria-label={reviewCopy.loadingReview} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex h-4 items-center">
            <div className="h-3 w-16 rounded-sm bg-surface-2" />
          </div>
          <div className="flex flex-col gap-3 rounded-md bg-surface-1 p-4">
            <div className="flex h-5.5 items-center">
              <div className="h-4 w-4/5 rounded-sm bg-surface-2" />
            </div>
            <div className="flex flex-wrap justify-between gap-4 border-y border-line py-3">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex flex-col gap-1">
                  <div className="h-4 w-12 rounded-sm bg-surface-2" />
                  <div className="h-8.5 w-18 rounded-sm bg-surface-2" />
                </div>
              ))}
            </div>
            {["w-24", "w-20", "w-16"].map((label) => (
              <div key={label} className="flex flex-col gap-1">
                <div className="flex h-4 items-center">
                  <div className={cn("h-3 rounded-sm bg-surface-2", label)} />
                </div>
                <div className="flex h-5.5 items-center">
                  <div className="h-4 w-full rounded-sm bg-surface-2" />
                </div>
                <div className="flex h-5.5 items-center">
                  <div className="h-4 w-2/3 rounded-sm bg-surface-2" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex h-5.5 items-center">
            <div className="h-4 w-24 rounded-sm bg-surface-2" />
          </div>
          <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
            {Array.from({ length: 5 }, (_, position) => (
              <div key={position} className="flex h-13 items-center gap-3">
                <div className="h-3 w-16 rounded-sm bg-surface-2" />
                <div className="h-4 flex-1 rounded-sm bg-surface-2" />
                <div className="h-4 w-12 rounded-sm bg-surface-2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </ReviewLayout>
  );
}
