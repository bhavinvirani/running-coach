import type { CoachFeedback } from "@running-coach/shared";
import { ThumbsDown, ThumbsUp, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";

type FeedbackThumbsProps = {
  /** The thumb the runner gave the card, null for none. */
  feedback: CoachFeedback | null;
  /** The thumb tapped, or null when the selected one was tapped again, which clears it. */
  onChange: (feedback: CoachFeedback | null) => void;
  /** Why saving the last tap failed. */
  error: Error | null;
};

/**
 * Helpful and Not helpful under a card the coach wrote: the run's coach card and the weekly review. Only on
 * the model's cards: a fallback card is not the coach's work to rate.
 */
export function FeedbackThumbs({ feedback, onChange, error }: FeedbackThumbsProps) {
  const toggle = (value: CoachFeedback) => onChange(feedback === value ? null : value);

  return (
    <>
      <div className="-mr-2 flex justify-end gap-1">
        <Thumb
          icon={ThumbsUp}
          label="Helpful"
          pressed={feedback === "up"}
          onClick={() => toggle("up")}
        />
        <Thumb
          icon={ThumbsDown}
          label="Not helpful"
          pressed={feedback === "down"}
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

/**
 * The word beside the icon is the label. Pressed is drawn like the app's other toggles (SegmentedField),
 * not in accent, which is kept for the primary action.
 */
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
      className={cn(
        "px-3",
        // Also under the pointer: ghost's hover background would hide the pressed state after a click.
        pressed
          ? "bg-surface-2 font-semibold text-ink hover:bg-surface-2"
          : "font-normal text-ink-2",
      )}
    >
      <Icon aria-hidden="true" strokeWidth={1.75} />
      {label}
    </Button>
  );
}
