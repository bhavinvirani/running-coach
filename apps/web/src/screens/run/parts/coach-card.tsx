import type {
  CoachFallbackReason,
  CoachFeedback,
  InsightResponse,
  RunInsight,
  RunInsightCard,
} from "@running-coach/shared";
import { ThumbsDown, ThumbsUp, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import type { ScreenState } from "@/api/screen-state";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { Note, RunSection } from "./run-section";

const TITLE = "Coach";

type CoachCardProps = {
  state: ScreenState<InsightResponse>;
  /** Ask the coach, or Try again after a fallback card. */
  ask: () => void;
  asking: boolean;
  askError: Error | null;
  setFeedback: (insightId: string, feedback: CoachFeedback | null) => void;
  feedbackError: Error | null;
};

/**
 * The coach's review of the run, right under the stats: what happened, what it means, what to do next.
 * Loads beside the run and has its own loading and error states, so a slow or failed coach never hides
 * the run. Without a Claude key the card is one sentence and the way to add one, nothing else.
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
      return (
        <p role="status" className="text-body text-ink-2">
          Coach unavailable, will retry.
        </p>
      );
    case "ready":
      return (
        <>
          <InsightText
            content={response.insight.content}
            fallback={response.insight.fallbackReason !== null}
          />
          {response.insight.fallbackReason === null ? (
            <Thumbs insight={response.insight} setFeedback={setFeedback} error={feedbackError} />
          ) : (
            <FallbackAction
              reason={response.insight.fallbackReason}
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
      <Button asChild variant="secondary" className="self-start">
        <Link to="/settings">Add Claude key</Link>
      </Button>
    </>
  );
}

/**
 * A failed Ask the coach or Try again: 429, or the API down. A 409 claude_key_missing shows here only until
 * the card is read again and answers no_key (useAskCoach).
 */
function AskAlert({ error }: { error: Error | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="text-body text-ink">
      {errorMessage(error)}
    </p>
  );
}

const CAUTION_TEXT = {
  easy_next: "Make the next run easy",
  rest_and_check: "Rest, and see a professional if it persists",
} as const;

/**
 * The headline, then the three parts in the coach's order, and the caution when there is one. A fallback
 * card's middle part says why there is no review rather than what the run means, so it reads as its own
 * sentence, without the label.
 */
function InsightText({ content, fallback }: { content: RunInsight; fallback: boolean }) {
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

function Part({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-caption text-ink-2">{label}</h3>
      <p className="text-body text-ink">{text}</p>
    </div>
  );
}

/**
 * A fallback card already says why the coach could not write one; this is what to do about it. A missing
 * key is added in Settings. A rejected key is replaced there, and Try again stays beside it for when it
 * already was (the card is from before) or Claude turned the key down only for a moment; any other reason
 * may pass on another try.
 */
function FallbackAction({
  reason,
  ask,
  asking,
  askError,
}: {
  reason: CoachFallbackReason;
  ask: () => void;
  asking: boolean;
  askError: Error | null;
}) {
  if (reason === "missing_key") {
    return (
      <Button asChild variant="secondary" className="self-start">
        <Link to="/settings">Add Claude key</Link>
      </Button>
    );
  }
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
  // Tapping the selected thumb clears it.
  const toggle = (value: CoachFeedback) =>
    setFeedback(insight.id, insight.feedback === value ? null : value);

  return (
    <>
      <div className="-mr-2 flex justify-end gap-1">
        <Thumb
          icon={ThumbsUp}
          label="Helpful"
          pressed={insight.feedback === "up"}
          onClick={() => toggle("up")}
        />
        <Thumb
          icon={ThumbsDown}
          label="Not helpful"
          pressed={insight.feedback === "down"}
          onClick={() => toggle("down")}
        />
      </div>
      {error ? (
        <p role="alert" className="text-body text-ink">
          {errorMessage(error)}
        </p>
      ) : null}
    </>
  );
}

/** The word beside the icon is the label; accent marks the selected one only. */
function Thumb({
  icon: Icon,
  label,
  pressed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn("px-3 font-normal", pressed ? "text-accent" : "text-ink-2")}
    >
      <Icon aria-hidden="true" strokeWidth={1.75} />
      {label}
    </Button>
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
