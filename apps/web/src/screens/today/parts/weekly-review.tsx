import type { CoachFeedback, LatestReviewResponse, Units } from "@running-coach/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ScreenState } from "@/api/screen-state";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { WeeklyReviewCard } from "@/components/weekly-review-card";
import { planLimitLine, reviewCopy } from "@/lib/weekly-review";

export type WeeklyReviewState = {
  state: ScreenState<LatestReviewResponse>;
  /**
   * From /api/me: whether the coach has a credential. With one, a review is there most of the week, so its
   * place is held while it loads; without one there is never a review to wait for.
   */
  hasCredential: boolean;
  setFeedback: (reviewId: string, feedback: CoachFeedback | null) => void;
  feedbackError: Error | null;
};

type WeeklyReviewProps = WeeklyReviewState & {
  units: Units;
  /** The runner's local date. */
  today: string;
  /** The runner's time zone, for when the coach writes the review after the plan's usage limit resets. */
  timeZone: string;
  /**
   * Today's empty state, before the first run: a written review only, nothing about one to come. A failed
   * read still shows its alert and Retry when the coach has a credential, since a review may be waiting.
   */
  readyOnly?: boolean;
};

/**
 * The coach's review of the week that ended, between the latest run and the next 7 days, from its
 * Monday to its Sunday, with Open weekly reviews. While the coach writes it, or Claude failed and the job
 * will retry, it is one line; with no review to show, nothing. A failed read never hides Today: the alert
 * and Retry take the card's place, and a failed reload keeps the card with them above it. The coming week
 * is Today's Next 7 days, so the card leaves out its own preview.
 */
export function WeeklyReview({
  state,
  hasCredential,
  setFeedback,
  feedbackError,
  units,
  today,
  timeZone,
  readyOnly = false,
}: WeeklyReviewProps) {
  if (state.status === "pending") {
    return hasCredential && !readyOnly ? <WeeklyReviewSkeleton /> : null;
  }

  if (state.status === "error") {
    if (readyOnly && !hasCredential) return null;
    return (
      <Region>
        <RetryAlert error={state.error} onRetry={() => void state.refetch()} />
      </Region>
    );
  }

  const response = state.data;
  const refetchFailed = state.refetchError ? (
    <RetryAlert error={state.refetchError} onRetry={() => void state.refetch()} />
  ) : null;
  if (readyOnly && response.state !== "ready") {
    return hasCredential && refetchFailed !== null ? <Region>{refetchFailed}</Region> : null;
  }

  switch (response.state) {
    case "ready":
      return (
        <section aria-label={reviewCopy.title} className="flex flex-col gap-2">
          <Heading>
            <Button asChild variant="secondary">
              <Link to="/plan/reviews">{reviewCopy.openList}</Link>
            </Button>
          </Heading>
          {refetchFailed}
          <WeeklyReviewCard
            review={response.review}
            units={units}
            today={today}
            setFeedback={setFeedback}
            feedbackError={feedbackError}
          />
        </section>
      );
    case "pending":
      return (
        <Region>
          {refetchFailed}
          <p role="status" className="text-body text-ink-2">
            {reviewCopy.pending}
          </p>
        </Region>
      );
    case "retrying":
      return (
        <Region>
          {refetchFailed}
          <p role="status" className="text-body text-ink-2">
            {response.resumesAt === undefined
              ? reviewCopy.unavailable
              : planLimitLine(response.resumesAt, timeZone)}
          </p>
        </Region>
      );
    case "none":
      return refetchFailed === null ? null : <Region>{refetchFailed}</Region>;
  }
}

/** A line in the card's place, named for screen readers like the card. */
function Region({ children }: { children: ReactNode }) {
  return (
    <section aria-label={reviewCopy.title} className="flex flex-col gap-2">
      {children}
    </section>
  );
}

/** As tall as Open weekly reviews, so the heading stays put whether or not the button shows. */
function Heading({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <h2 className="text-body font-semibold text-ink">{reviewCopy.title}</h2>
      {children}
    </div>
  );
}

/** The heading, the dates and the card's headline, stats and first part at their loaded heights. */
function WeeklyReviewSkeleton() {
  return (
    <section aria-label={reviewCopy.title} aria-busy className="flex flex-col gap-2">
      <Heading />
      <div role="status" aria-label={reviewCopy.loadingReview} className="flex flex-col gap-2">
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
          <div className="flex flex-col gap-1">
            <div className="flex h-4 items-center">
              <div className="h-3 w-24 rounded-sm bg-surface-2" />
            </div>
            <div className="flex h-5.5 items-center">
              <div className="h-4 w-full rounded-sm bg-surface-2" />
            </div>
            <div className="flex h-5.5 items-center">
              <div className="h-4 w-2/3 rounded-sm bg-surface-2" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
