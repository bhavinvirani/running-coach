import type {
  CoachFallbackReason,
  CoachFeedback,
  InsightResponse,
  PlanChange,
  RunInsight,
  RunInsightCard,
  Units,
} from "@running-coach/shared";
import { Link } from "react-router";
import type { ScreenState } from "@/api/screen-state";
import { FeedbackThumbs } from "@/components/feedback-thumbs";
import { PlanChangeText } from "@/components/plan-change-text";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorMessage, isVersionMismatch } from "@/lib/errors";
import { formatDayTime } from "@/lib/format";
import { Note, RunSection } from "./run-section";

const TITLE = "Coach";

type CoachCardProps = {
  state: ScreenState<InsightResponse>;
  /**
   * From /api/me: whether the coach has a credential, a saved key or the owner's Claude plan. Without one a
   * fallback card's one action is Add Claude key.
   */
  hasCredential: boolean;
  /** The runner's time zone from settings, for when the coach tries again after the plan's usage limit. */
  timeZone: string;
  /** The runner's units, for the distances of the plan change the coach made. */
  units: Units;
  /** Ask the coach, Try again after a fallback card, or Try now while the plan's usage limit holds the job. */
  ask: () => void;
  asking: boolean;
  askError: Error | null;
  setFeedback: (insightId: string, feedback: CoachFeedback | null) => void;
  feedbackError: Error | null;
};

/**
 * The coach's review of the run, right under the stats: what happened, what it means, what to do next.
 * Loads beside the run and has its own loading and error states, so a slow or failed coach never hides
 * the run, except a first answer this version cannot read: that goes to the route's boundary
 * (throwOnFirstLoadMismatch), since only the server's version of the app can show it. Without a credential
 * (no key, and not the owner's Claude plan) a run with no card is one sentence and the way to add a key,
 * nothing else; a stored card keeps its text, and a fallback card offers only that same way to add one.
 */
export function CoachCard({ state, ...actions }: CoachCardProps) {
  if (state.status === "pending") {
    return (
      <RunSection title={TITLE} className="mt-2">
        <div role="status" aria-label="Loading the coach review">
          <InsightSkeleton />
        </div>
      </RunSection>
    );
  }

  if (state.status === "error") {
    return (
      <RunSection title={TITLE} className="mt-2">
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-body text-ink">
            {errorMessage(state.error)}
          </p>
          <Button variant="secondary" onClick={() => void state.refetch()}>
            Retry
          </Button>
        </div>
      </RunSection>
    );
  }

  return (
    <RunSection title={TITLE} className="mt-2">
      {state.refetchError ? (
        <RetryAlert error={state.refetchError} onRetry={() => void state.refetch()} />
      ) : null}
      <CoachBody response={state.data} {...actions} />
    </RunSection>
  );
}

function CoachBody({
  response,
  hasCredential,
  timeZone,
  units,
  ask,
  asking,
  askError,
  setFeedback,
  feedbackError,
}: Omit<CoachCardProps, "state"> & { response: InsightResponse }) {
  switch (response.state) {
    case "no_key":
      return <AddKey />;
    case "none":
      return (
        <>
          <Note>No coach review for this run yet.</Note>
          <AskAlert error={askError} />
          <Button className="self-start" disabled={asking} aria-busy={asking} onClick={ask}>
            Ask the coach
          </Button>
        </>
      );
    case "pending":
      return (
        <div role="status" className="flex flex-col gap-3">
          <Note>The coach is reviewing this run.</Note>
          <InsightSkeleton />
        </div>
      );
    case "retrying":
      return response.resumesAt === undefined ? (
        <p role="status" className="text-body text-ink-2">
          Coach unavailable, will retry.
        </p>
      ) : !hasCredential ? (
        // The plan was withdrawn on the server while the job waited: at the reset it finds no credential,
        // and Try now could only answer 409.
        <AddKeyLink />
      ) : (
        <PlanLimit
          resumesAt={response.resumesAt}
          timeZone={timeZone}
          ask={ask}
          asking={asking}
          askError={askError}
        />
      );
    case "ready":
      return (
        <>
          <InsightText
            content={response.insight.content}
            fallback={response.insight.fallbackReason !== null}
            planChange={response.insight.planChange}
            units={units}
          />
          {response.insight.fallbackReason === null ? (
            <Thumbs insight={response.insight} setFeedback={setFeedback} error={feedbackError} />
          ) : (
            <FallbackAction
              reason={response.insight.fallbackReason}
              hasCredential={hasCredential}
              ask={ask}
              asking={asking}
              askError={askError}
            />
          )}
        </>
      );
  }
}

/** No key, so no coach: the one thing to do about it. */
function AddKey() {
  return (
    <>
      <Note>Add your Claude API key to get a coach review after each run.</Note>
      <AddKeyLink />
    </>
  );
}

function AddKeyLink() {
  return (
    <Button asChild variant="secondary" className="self-start">
      <Link to="/settings">Add Claude key</Link>
    </Button>
  );
}

/**
 * A failed Ask the coach or Try again: 429, or the API down. A 409 claude_key_missing shows here only until
 * the card and /api/me are read again (useAskCoach): a run without a card then answers no_key, and a fallback
 * card, told there is no key, swaps this and Try again for Add Claude key. An answer this version cannot read
 * gets Reload beside it: asking again gets the same answer, and only the server's version can show where the
 * coach stands.
 */
function AskAlert({ error }: { error: Error | null }) {
  if (error === null) return null;
  const alert = (
    <p role="alert" className="text-body text-ink">
      {errorMessage(error)}
    </p>
  );
  if (!isVersionMismatch(error)) return alert;
  return (
    <div className="flex items-center justify-between gap-3">
      {alert}
      <Button variant="ghost" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

/**
 * The coach's job waits for the owner's Claude plan usage limit to reset: when it runs again, in the runner's
 * zone, and Try now, which asks the API to run it at once (the limit may already have reset early). Asking
 * answers the new state: pending, or this again with a later reset.
 */
function PlanLimit({
  resumesAt,
  timeZone,
  ask,
  asking,
  askError,
}: {
  resumesAt: string;
  timeZone: string;
  ask: () => void;
  asking: boolean;
  askError: Error | null;
}) {
  return (
    <>
      <p role="status" className="text-body text-ink-2">
        Your Claude plan&apos;s usage limit is reached. The coach tries again{" "}
        {formatDayTime(resumesAt, timeZone)}.
      </p>
      <AskAlert error={askError} />
      <Button
        variant="secondary"
        className="self-start"
        disabled={asking}
        aria-busy={asking}
        onClick={ask}
      >
        Try now
      </Button>
    </>
  );
}

const CAUTION_TEXT = {
  easy_next: "Make the next run easy",
  rest_and_check: "Rest, and see a professional if it persists",
} as const;

/**
 * The headline, then the three parts in the coach's order, the change the coach made to the plan when the
 * engine applied one, and the caution when there is one. A fallback card's middle part says why there is
 * no review rather than what the run means, so it reads as its own sentence, without the label.
 */
function InsightText({
  content,
  fallback,
  planChange,
  units,
}: {
  content: RunInsight;
  fallback: boolean;
  planChange: PlanChange | null;
  units: Units;
}) {
  return (
    <>
      <p className="text-body font-semibold text-ink">{content.headline}</p>
      <Part label="What happened" text={content.whatHappened} />
      {fallback ? (
        <p className="text-body text-ink">{content.whatItMeans}</p>
      ) : (
        <Part label="What it means" text={content.whatItMeans} />
      )}
      <Part label="Next" text={content.nextStep} />
      {planChange === null ? null : <PlanChangePart change={planChange} units={units} />}
      {content.caution === "none" ? null : (
        <p className="flex items-center gap-2 text-body font-semibold text-ink">
          {/* The words carry the caution; the dot is red only for rest, the one that can mean injury. */}
          <span
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 rounded-sm",
              content.caution === "rest_and_check" ? "bg-bad" : "bg-ink-3",
            )}
          />
          {CAUTION_TEXT[content.caution]}
        </p>
      )}
    </>
  );
}

/**
 * What the coach changed, from the engine's log rather than the coach's words: "Thu 8 Intervals 11.6 km →
 * Easy 10.6 km", and a caption when the engine pulled the coach's proposal inside the plan's caps.
 */
function PlanChangePart({ change, units }: { change: PlanChange; units: Units }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-caption text-ink-2">Plan change</h3>
      <PlanChangeText change={change} units={units} />
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
 * A fallback card already says why the coach could not write one; this is what to do about it. With no
 * credential, whatever the reason, the one action is Add Claude key: Try again could only answer 409. A
 * rejected key is replaced in Settings, and Try again stays beside it for when it already was (the card is
 * from before) or Claude turned the key down only for a moment. A rejected plan token is fixed on the server
 * (a new token from claude setup-token), so the runner can only try again; so may any other reason.
 */
function FallbackAction({
  reason,
  hasCredential,
  ask,
  asking,
  askError,
}: {
  reason: CoachFallbackReason;
  hasCredential: boolean;
  ask: () => void;
  asking: boolean;
  askError: Error | null;
}) {
  if (reason === "missing_key" || !hasCredential) return <AddKeyLink />;
  const tryAgain = (
    <Button
      variant="secondary"
      className="self-start"
      disabled={asking}
      aria-busy={asking}
      onClick={ask}
    >
      Try again
    </Button>
  );
  return (
    <>
      <AskAlert error={askError} />
      {reason === "key_invalid" ? (
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="secondary">
            <Link to="/settings">Replace key</Link>
          </Button>
          {tryAgain}
        </div>
      ) : (
        tryAgain
      )}
    </>
  );
}

/** Thumbs on the model's cards only: a fallback card is not the coach's work to rate. */
function Thumbs({
  insight,
  setFeedback,
  error,
}: {
  insight: RunInsightCard;
  setFeedback: (insightId: string, feedback: CoachFeedback | null) => void;
  error: Error | null;
}) {
  return (
    <FeedbackThumbs
      feedback={insight.feedback}
      onChange={(feedback) => setFeedback(insight.id, feedback)}
      error={error}
    />
  );
}

/** The card's final layout as blocks: the headline, then three parts of a label and two lines. */
function InsightSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      <Line width="w-4/5" />
      {["w-24", "w-20", "w-12"].map((label) => (
        <div key={label} className="flex flex-col gap-1">
          <div className="flex h-4 items-center">
            <div className={cn("h-3 rounded-sm bg-surface-2", label)} />
          </div>
          <Line width="w-full" />
          <Line width="w-2/3" />
        </div>
      ))}
    </div>
  );
}

/** One line of body text: a block at the text's line height, so nothing jumps when it arrives. */
function Line({ width }: { width: string }) {
  return (
    <div className="flex h-5.5 items-center">
      <div className={cn("h-4 rounded-sm bg-surface-2", width)} />
    </div>
  );
}
