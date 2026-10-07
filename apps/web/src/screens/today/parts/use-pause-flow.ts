import type { PauseReason, PauseResponse, ReEntry } from "@running-coach/shared";
import { useEffect, useId, useRef, useState } from "react";
import type { ScreenState } from "@/api/screen-state";

/** The runner's open pause and the two ways to change it, as Today's hook composes them. */
export type PauseState = {
  /** GET /api/pause; pending until the calendar says there is a plan to pause. */
  state: ScreenState<PauseResponse>;
  starting: boolean;
  startError: Error | null;
  /** Pause training; `onStarted` runs once the sessions are read again with the pause. */
  onStart: (reason: PauseReason, onStarted: () => void) => void;
  /** Forgets a failed start, so the panel opens without it. */
  onChoose: () => void;
  ending: boolean;
  endError: Error | null;
  /**
   * I'm back; `onEnded` runs once the sessions are read again without the pause, with what the re-entry
   * did, null when no pause was open by then.
   */
  onEnd: (onEnded: (reEntry: ReEntry | null) => void) => void;
  /** What the last I'm back did to the plan; null before one, or when no pause was open by then. */
  reEntry: ReEntry | null;
};

type FocusTarget = "entry" | "question" | "paused" | "outcome";

/**
 * Not feeling 100%, its panel and the paused card are one flow on Today, placed apart: the entry beside
 * the Next 7 days heading, the panel under it, the paused card and the line after I'm back above it. Each
 * step swaps out the button that was focused, so focus follows, by id since the pieces render apart, and
 * only on a render the runner caused: to the panel's question on open, back to Not feeling 100% on Keep
 * training, to the paused card once the pause starts and to the outcome line once it ends (to Not feeling
 * 100% when it ended with nothing to say). A pause already open on load takes no focus.
 */
export function usePauseFlow(pause: PauseState) {
  const [choosing, setChoosing] = useState(false);
  const base = useId();
  const ids: Readonly<Record<FocusTarget, string>> = {
    entry: `${base}entry`,
    question: `${base}question`,
    paused: `${base}paused`,
    outcome: `${base}outcome`,
  };
  const focusAfterSwap = useRef<FocusTarget | null>(null);

  useEffect(() => {
    const target = focusAfterSwap.current;
    if (target === null) return;
    // The pause reaches its cache a tick after the mutation's own callbacks run, so the card or the
    // entry may render a render later than the state that swapped them: the target waits for it.
    const element = document.getElementById(`${base}${target}`);
    if (element === null) return;
    focusAfterSwap.current = null;
    element.focus();
  });

  const open = pause.state.status === "success" ? pause.state.data.pause : null;

  return {
    ids,
    /** Not feeling 100% shows once the pause is known to be closed, and not while its panel is open. */
    canPause: pause.state.status === "success" && open === null && !choosing,
    /** The panel is open; a pause that opened meanwhile (another device) closes it. */
    choosing: choosing && open === null,
    /** The open pause, null while training runs or while it is not known yet. */
    open,
    choose: () => {
      pause.onChoose();
      focusAfterSwap.current = "question";
      setChoosing(true);
    },
    keepTraining: () => {
      focusAfterSwap.current = "entry";
      setChoosing(false);
    },
    start: (reason: PauseReason) =>
      pause.onStart(reason, () => {
        focusAfterSwap.current = "paused";
        setChoosing(false);
      }),
    end: () =>
      pause.onEnd((reEntry) => {
        // Without a re-entry there is no line to read, so focus goes back to Not feeling 100%.
        focusAfterSwap.current = reEntry === null ? "entry" : "outcome";
      }),
  };
}

export type PauseFlow = ReturnType<typeof usePauseFlow>;
