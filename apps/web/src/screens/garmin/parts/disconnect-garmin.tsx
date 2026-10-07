import { ErrorCode } from "@running-coach/shared";
import { useEffect, useId, useRef, useState } from "react";
import { isApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { errorMessage } from "@/lib/errors";
import { disconnectedLine, garminCopy } from "../garmin-copy";
import type { DisconnectActions } from "../use-garmin";

type DisconnectGarminProps = {
  /** Removing the app's workouts takes Garmin calls, so only a working login can; an expired one keeps. */
  canRemove: boolean;
  disconnect: DisconnectActions;
  /** A disconnect is going out, so the line the last connect left no longer applies. */
  onStart: () => void;
  /** The line saying what the disconnect did, for the screen to show once the form for connecting is back. */
  onDisconnected: (line: string) => void;
};

/**
 * Disconnect Garmin, confirmed in place (never a browser dialog), as SessionActions confirms a skip: the
 * question, the choice to remove the app's upcoming workouts from Garmin first (on by default), then
 * Disconnect Garmin and Cancel. A failure keeps the login and the step. Garmin turning the removal down
 * means the login expired: the choice turns to keep, and /api/me read again drops it once it says expired;
 * a reconnect after that brings the choice back on and drops the refusal. Opened again while a disconnect
 * still runs (the screen was left and came back), the step shows it running. Swapping the button for the
 * step takes away the focused control, so focus follows: to the question, back to Disconnect Garmin on
 * Cancel.
 */
export function DisconnectGarmin({
  canRemove,
  disconnect,
  onStart,
  onDisconnected,
}: DisconnectGarminProps) {
  const { pending, removing } = disconnect;
  const [confirming, setConfirming] = useState(pending);
  const [removeWorkouts, setRemoveWorkouts] = useState(!pending || removing);
  const [problem, setProblem] = useState<string | null>(null);
  const questionId = useId();
  const checkboxId = useId();
  const question = useRef<HTMLParagraphElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  // Set with the swap, so only a render the runner caused moves focus, never a refetch.
  const focusAfterSwap = useRef<"question" | "disconnect" | null>(null);

  // Reconnected: removal works again, so the choice is back on and the refusal no longer holds. Without
  // this the cleared box would send keep after the reconnect the refusal asked for.
  const [couldRemove, setCouldRemove] = useState(canRemove);
  if (canRemove !== couldRemove) {
    setCouldRemove(canRemove);
    if (canRemove) {
      setRemoveWorkouts(true);
      setProblem(null);
    }
  }

  useEffect(() => {
    const target = focusAfterSwap.current;
    focusAfterSwap.current = null;
    if (target === "question") question.current?.focus();
    if (target === "disconnect") disconnectButton.current?.focus();
  });

  if (!confirming) {
    return (
      <div className="py-4">
        <Button
          ref={disconnectButton}
          variant="secondary"
          onClick={() => {
            focusAfterSwap.current = "question";
            setConfirming(true);
          }}
        >
          {garminCopy.disconnect.idle}
        </Button>
      </div>
    );
  }

  const workouts = canRemove && removeWorkouts ? "remove" : "keep";

  const confirm = () => {
    if (pending) return;
    setProblem(null);
    onStart();
    disconnect.disconnect(
      { workouts },
      {
        onSuccess: ({ removedWorkouts }) =>
          onDisconnected(disconnectedLine(workouts, removedWorkouts)),
        onError: (error) => {
          if (
            workouts === "remove" &&
            isApiError(error) &&
            error.code === ErrorCode.garminAuthExpired
          ) {
            setRemoveWorkouts(false);
            setProblem(garminCopy.removalNeedsLogin);
            return;
          }
          setProblem(errorMessage(error));
        },
      },
    );
  };

  const cancel = () => {
    focusAfterSwap.current = "disconnect";
    // Opened again, the step starts as new: removal on, no error from the last try.
    setRemoveWorkouts(true);
    setProblem(null);
    setConfirming(false);
  };

  return (
    <div role="group" aria-labelledby={questionId} className="flex flex-col items-start gap-3 py-4">
      <p id={questionId} ref={question} tabIndex={-1} className="text-body text-ink">
        {garminCopy.disconnectQuestion}
      </p>
      {canRemove ? (
        <label htmlFor={checkboxId} className="flex min-h-11 cursor-pointer items-center gap-3">
          <Checkbox
            id={checkboxId}
            checked={removeWorkouts}
            disabled={pending}
            onCheckedChange={(checked) => setRemoveWorkouts(checked === true)}
          />
          <span className="text-body text-ink">{garminCopy.removeWorkouts}</span>
        </label>
      ) : (
        <p className="text-body text-ink-2">{garminCopy.keepOnly}</p>
      )}
      {removing ? (
        <p role="status" className="text-body text-ink-2">
          {garminCopy.removing}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="text-body text-ink">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button disabled={pending} aria-busy={pending} onClick={confirm}>
          {pending ? garminCopy.disconnect.pending : garminCopy.disconnect.idle}
        </Button>
        <Button variant="ghost" disabled={pending} onClick={cancel}>
          {garminCopy.cancel}
        </Button>
      </div>
    </div>
  );
}
