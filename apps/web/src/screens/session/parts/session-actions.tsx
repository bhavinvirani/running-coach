import type { MoveWarning, PlanSession } from "@running-coach/shared";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatShortDay } from "@/lib/format";
import { moveWarningSentence, sessionCopy } from "../session-copy";
import { moveDays } from "@/lib/session-days";

export type MoveState = {
  moving: boolean;
  error: Error | null;
  /** The last move's warning, with the date it moved to. */
  warning: { date: string; warning: MoveWarning } | null;
  onMove: (date: string, onMoved: () => void) => void;
};

export type SkipState = {
  skipping: boolean;
  error: Error | null;
  onSkip: () => void;
};

type SessionActionsProps = {
  session: PlanSession;
  /** The session's name as its screen shows it, for the move warning. */
  name: string;
  /** The runner's local date. */
  today: string;
  move: MoveState;
  skip: SkipState;
};

/**
 * What the runner can do with a session to come: Move to another day of its week, Skip session (a plan
 * session) or Delete workout (the runner's own), each confirmed in place, and Edit workout for their own.
 * The caller shows it only while canChange holds.
 */
export function SessionActions({ session, name, today, move, skip }: SessionActionsProps) {
  const [moving, setMoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const custom = session.source === "custom";
  const days = moveDays(session, today);
  const skipLabel = custom ? sessionCopy.remove : sessionCopy.skip;

  if (confirming) {
    return (
      <div className="flex flex-col gap-3 rounded-md bg-surface-1 p-4">
        <p className="text-body text-ink">
          {custom ? sessionCopy.removeQuestion : sessionCopy.skipQuestion}
        </p>
        {skip.error ? (
          <p role="alert" className="text-body text-ink">
            {errorMessage(skip.error)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={skip.skipping} aria-busy={skip.skipping} onClick={skip.onSkip}>
            {skipLabel}
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            {custom ? sessionCopy.keepWorkout : sessionCopy.keepSession}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {days.length > 0 ? (
          <Button
            variant="secondary"
            aria-expanded={moving}
            onClick={() => setMoving((open) => !open)}
          >
            {sessionCopy.move}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          {skipLabel}
        </Button>
        {custom ? (
          <Button asChild variant="secondary">
            <Link to={`/plan/sessions/${session.id}/edit`}>{sessionCopy.edit}</Link>
          </Button>
        ) : null}
      </div>
      {moving ? (
        <div role="group" aria-label={sessionCopy.moveTo} className="flex flex-wrap gap-2">
          {days.map((date) => (
            <Button
              key={date}
              variant="secondary"
              className="rounded-full"
              disabled={move.moving}
              onClick={() => move.onMove(date, () => setMoving(false))}
            >
              {formatShortDay(date)}
            </Button>
          ))}
        </div>
      ) : null}
      {move.error ? (
        <p role="alert" className="text-body text-ink">
          {errorMessage(move.error)}
        </p>
      ) : move.warning ? (
        <p role="status" className="text-body text-ink">
          {moveWarningSentence(name, move.warning.date, move.warning.warning)}
        </p>
      ) : null}
    </div>
  );
}
