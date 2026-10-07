import type { PauseReason, TrainingPause } from "@running-coach/shared";
import { useState } from "react";
import { RetryAlert } from "@/components/retry-alert";
import { SegmentedField, type SegmentOption } from "@/components/segmented-field";
import { Button } from "@/components/ui/button";
import {
  PAUSE_ADVICE,
  PAUSE_REASON_LABELS,
  isHealthReason,
  reEntryLine,
  todayCopy,
} from "../today-copy";
import type { PauseFlow, PauseState } from "./use-pause-flow";

const REASON_OPTIONS: readonly SegmentOption<PauseReason>[] = (
  ["sick", "injured", "break"] as const
).map((value) => ({ value, label: PAUSE_REASON_LABELS[value] }));

/** The entry beside the Next 7 days heading. */
export function NotFeelingButton({ flow }: { flow: PauseFlow }) {
  if (!flow.canPause) return null;
  return (
    <Button id={flow.ids.entry} variant="secondary" onClick={flow.choose}>
      {todayCopy.notFeeling}
    </Button>
  );
}

/**
 * The choice in place, as SessionActions confirms a skip: the question, the three reasons, the selected
 * one's advice, then Pause training and Keep training. Nothing is sent until Pause training. The caller
 * mounts it while flow.choosing, so each opening starts with no reason chosen.
 */
export function PausePanel({ flow, pause }: { flow: PauseFlow; pause: PauseState }) {
  const [reason, setReason] = useState<PauseReason | null>(null);

  return (
    <div
      role="group"
      aria-labelledby={flow.ids.question}
      className="flex flex-col gap-3 rounded-md bg-surface-1 p-4"
    >
      <p id={flow.ids.question} tabIndex={-1} className="text-body text-ink">
        {todayCopy.pauseQuestion}
      </p>
      <SegmentedField
        name="pause-reason"
        legend={todayCopy.pauseReason}
        options={REASON_OPTIONS}
        value={reason}
        onChange={setReason}
      />
      {/* Polite: the advice changes under the radio the runner just moved, not where focus is. */}
      <div aria-live="polite">{reason === null ? null : <Advice reason={reason} />}</div>
      {pause.startError && reason !== null ? (
        <RetryAlert error={pause.startError} onRetry={() => flow.start(reason)} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={reason === null || pause.starting}
          aria-busy={pause.starting}
          onClick={() => {
            if (reason !== null) flow.start(reason);
          }}
        >
          {todayCopy.pauseTraining}
        </Button>
        <Button variant="ghost" onClick={flow.keepTraining}>
          {todayCopy.keepTraining}
        </Button>
      </div>
    </div>
  );
}

/**
 * Above the Next 7 days while a pause is open: since when, the reason's advice again, and I'm back. Before
 * a pause, the line I'm back left, or why the pause could not be read, with Retry.
 */
export function PauseNotice({ flow, pause }: { flow: PauseFlow; pause: PauseState }) {
  const { state } = pause;
  if (state.status === "pending") return null;
  if (state.status === "error") {
    return <RetryAlert error={state.error} onRetry={() => void state.refetch()} />;
  }
  const refetchFailed = state.refetchError ? (
    <RetryAlert error={state.refetchError} onRetry={() => void state.refetch()} />
  ) : null;

  if (flow.open !== null) {
    return (
      <>
        {refetchFailed}
        <PausedCard pause={flow.open} flow={flow} state={pause} />
      </>
    );
  }
  return (
    <>
      {refetchFailed}
      {pause.reEntry === null ? null : (
        <p id={flow.ids.outcome} role="status" tabIndex={-1} className="text-body text-ink">
          {reEntryLine(pause.reEntry)}
        </p>
      )}
    </>
  );
}

function PausedCard({
  pause,
  flow,
  state,
}: {
  pause: TrainingPause;
  flow: PauseFlow;
  state: PauseState;
}) {
  return (
    <section
      aria-labelledby={flow.ids.paused}
      className="flex flex-col gap-3 rounded-md bg-surface-1 p-4"
    >
      <h2 id={flow.ids.paused} tabIndex={-1} className="text-body font-semibold text-ink">
        {todayCopy.pausedSince(pause.startDate)}
      </h2>
      <Advice reason={pause.reason} />
      {state.endError ? <RetryAlert error={state.endError} onRetry={flow.end} /> : null}
      <Button
        className="self-start"
        disabled={state.ending}
        aria-busy={state.ending}
        onClick={flow.end}
      >
        {todayCopy.imBack}
      </Button>
    </section>
  );
}

/** A reason's fixed advice, and for illness or injury the line that it is not medical advice. */
function Advice({ reason }: { reason: PauseReason }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-body text-ink">{PAUSE_ADVICE[reason]}</p>
      {isHealthReason(reason) ? (
        <p className="text-caption text-ink-2">{todayCopy.notMedicalAdvice}</p>
      ) : null}
    </div>
  );
}
