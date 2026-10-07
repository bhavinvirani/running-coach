import type {
  CoachFeedback,
  ReviewChange,
  ReviewSession,
  ReviewWeekSummary,
  Units,
  WeeklyReviewCard as Review,
} from "@running-coach/shared";
import { Link } from "react-router";
import { DotLine } from "@/components/dot-line";
import { FeedbackThumbs } from "@/components/feedback-thumbs";
import { PlanChangeText } from "@/components/plan-change-text";
import { SessionTypeChip } from "@/components/session-type-chip";
import { Stat } from "@/components/stat";
import { cn } from "@/lib/cn";
import { weekStart } from "@/lib/dates";
import { formatLocalDay, formatWeekRange } from "@/lib/format";
import { snapshotAmount } from "@/lib/session-adjustment";
import { comingSessionState, reviewCopy, weekStats } from "@/lib/weekly-review";
import { sessionName } from "@/lib/workout-steps";

type WeeklyReviewCardProps = {
  review: Review;
  units: Units;
  /** The runner's local date: a week outside this year names its year. */
  today: string;
  setFeedback: (reviewId: string, feedback: CoachFeedback | null) => void;
  /** Why saving the last thumb failed. */
  feedbackError: Error | null;
  /**
   * The coming week's sessions as they stand now, each opening its session: on the review screen. Today
   * leaves it out, since its Next 7 days already shows them.
   */
  comingWeek?: boolean;
};

/**
 * The coach's review of one Monday-to-Sunday week, on Today and the review screen: the week's dates (and
 * Training paused when a pause covered any of its days), then on one card the headline, distance, sessions
 * and time, what happened, what it means and next week, the changes the engine made to the coming week
 * with the coach's note for each, and thumbs. A fallback card says why there is no review in place of
 * what it means, without the label and without thumbs; it never changes the plan, and the next week's
 * review is its next try, so it offers no Try again.
 */
export function WeeklyReviewCard({
  review,
  units,
  today,
  setFeedback,
  feedbackError,
  comingWeek = false,
}: WeeklyReviewCardProps) {
  const { content } = review;
  const fallback = review.fallbackReason !== null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <DotLine className="text-caption text-ink-2">
          {formatWeekRange(review.weekStart, weekStart(today))}
          {review.summary.paused ? reviewCopy.paused : null}
        </DotLine>
        <div className="flex flex-col gap-3 rounded-md bg-surface-1 p-4">
          <p className="text-body font-semibold text-ink">{content.headline}</p>
          <WeekStats summary={review.summary} units={units} />
          <Part label={reviewCopy.whatHappened} text={content.whatHappened} />
          {fallback ? (
            <p className="text-body text-ink">{content.whatItMeans}</p>
          ) : (
            <Part label={reviewCopy.whatItMeans} text={content.whatItMeans} />
          )}
          <Part label={reviewCopy.nextWeek} text={content.nextWeek} />
          {review.changes.length > 0 ? <Changes changes={review.changes} units={units} /> : null}
          {fallback ? null : (
            <FeedbackThumbs
              feedback={review.feedback}
              onChange={(feedback) => setFeedback(review.id, feedback)}
              error={feedbackError}
            />
          )}
        </div>
      </div>
      {comingWeek && review.comingWeek.length > 0 ? (
        <ComingWeek sessions={review.comingWeek} units={units} />
      ) : null}
    </div>
  );
}

/** Natural widths, not three equal columns: "31.4 of 38.0 km" is wider than a third of 390 px. */
function WeekStats({ summary, units }: { summary: ReviewWeekSummary; units: Units }) {
  return (
    <div className="flex flex-wrap justify-between gap-4 border-y border-line py-3">
      {weekStats(summary, units).map((stat) => (
        <Stat key={stat.label} label={stat.label} value={stat.value} unit={stat.unit} />
      ))}
    </div>
  );
}

function Part({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-caption text-ink-2">{label}</h3>
      <p className="text-body text-ink">{text}</p>
    </div>
  );
}

/**
 * The coming week's sessions the engine changed for the review, by date: what each was and is now, from
 * the engine's log, whether it was kept inside the plan's caps, and the coach's note. A proposal the
 * engine rejected is never here, nor its note.
 */
function Changes({ changes, units }: { changes: ReviewChange[]; units: Units }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-caption text-ink-2">{reviewCopy.changes}</h3>
      <ul className="flex flex-col gap-3">
        {changes.map((change) => (
          <li key={change.sessionId} className="flex flex-col gap-1">
            <PlanChangeText change={change} units={units} />
            <p className="text-body text-ink-2">{change.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The week after the reviewed one as the plan holds it now, skipped sessions included. */
function ComingWeek({ sessions, units }: { sessions: ReviewSession[]; units: Units }) {
  return (
    <section aria-label={reviewCopy.comingWeek} className="flex flex-col gap-2">
      <h2 className="text-body font-semibold text-ink">{reviewCopy.comingWeek}</h2>
      <ol className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {sessions.map((session) => (
          <ComingSession key={session.id} session={session} units={units} />
        ))}
      </ol>
    </section>
  );
}

/**
 * One session: its day, its type's dot and name, then what happened to it (Done, Missed, Skipped) and its
 * distance, or its time for strength; a skipped one has nothing left to run, so no distance. It opens the
 * session's screen.
 */
function ComingSession({ session, units }: { session: ReviewSession; units: Units }) {
  const day = formatLocalDay(session.date);
  const name = sessionName(session);
  const skipped = session.status === "skipped";
  const state = comingSessionState(session.status);
  const amount = skipped ? null : snapshotAmount(session.target, units);
  const label = [day, name, state, amount].filter((part) => part !== null).join(", ");

  return (
    <li>
      <Link
        to={`/plan/sessions/${session.id}`}
        aria-label={label}
        className="-mx-2 flex min-h-11 items-center gap-3 rounded-sm px-2 py-1 active:bg-surface-2"
      >
        <time dateTime={session.date} className="w-20 shrink-0 text-caption text-ink-2">
          {day}
        </time>
        <span className={cn("min-w-0 flex-1 text-body", skipped ? "text-ink-2" : "text-ink")}>
          <SessionTypeChip type={session.type} name={name} />
        </span>
        <span className="flex shrink-0 gap-3 text-body text-ink">
          {state ? <span>{state}</span> : null}
          {amount ? <span>{amount}</span> : null}
        </span>
      </Link>
    </li>
  );
}
