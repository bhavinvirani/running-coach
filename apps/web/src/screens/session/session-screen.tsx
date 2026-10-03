import { distanceInUnits, type SessionDetailResponse, type Units } from "@running-coach/shared";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { BackLink } from "@/components/back-link";
import { DotLine } from "@/components/dot-line";
import { GarminPushLine, type SendState } from "@/components/garmin-push-line";
import { RetryAlert } from "@/components/retry-alert";
import { SessionTypeChip } from "@/components/session-type-chip";
import { Stat } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { MISSING, formatDistanceValue, formatDuration, formatLocalDay } from "@/lib/format";
import { garminCaption } from "@/lib/garmin-state";
import { sessionTypeName } from "@/lib/session-type";
import { sessionName } from "@/lib/workout-steps";
import { SessionActions, type MoveState, type SkipState } from "./parts/session-actions";
import { StepsList } from "./parts/steps-list";
import { sessionCopy, statusWord } from "./session-copy";
import { canChange } from "@/lib/session-days";
import { useSessionScreen } from "./use-session";

/**
 * One session at /plan/sessions/:id: its type and name, distance and time, the steps the watch runs with
 * their paces, where it stands on Garmin, and for a session still to come Move, Skip session or Delete
 * workout, and Edit workout for the runner's own. Keyed by id, so another session starts over.
 */
export function SessionScreen() {
  const { id = "" } = useParams();
  return <SessionView key={id} id={id} />;
}

/** Loading, error and content only. No empty state: the API answers with a session or with 404. */
function SessionView({ id }: { id: string }) {
  const screen = useSessionScreen(id);
  const { data, status, error, refetch, units, today } = screen;

  if (status === "pending" || units === undefined || today === undefined) {
    return <SessionSkeleton />;
  }

  if (status === "error") {
    return (
      <SessionLayout title={sessionCopy.title}>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </SessionLayout>
    );
  }

  return (
    <SessionLayout title={formatLocalDay(data.session.date)}>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <SessionContent
        detail={data}
        units={units}
        today={today}
        send={screen.send}
        move={screen.move}
        skip={screen.skip}
      />
    </SessionLayout>
  );
}

type SessionContentProps = {
  detail: SessionDetailResponse;
  units: Units;
  today: string;
  send: SendState;
  move: MoveState;
  skip: SkipState;
};

function SessionContent({ detail, units, today, send, move, skip }: SessionContentProps) {
  const { session, paces, garmin } = detail;
  const name = sessionName(session);
  const { distanceM, durationS } = session.target;
  const distance = distanceM > 0 ? formatDistanceValue(distanceInUnits(distanceM, units)) : MISSING;
  const caption = garminCaption(
    session,
    { ...garmin, pushing: garmin.pushing || send.sending },
    today,
  );

  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="text-body font-semibold text-ink">
          <SessionTypeChip type={session.type} name={name} />
        </p>
        <DotLine className="text-caption text-ink-2">
          {session.title === null ? null : sessionTypeName(session.type)}
          {statusWord(session.status)}
        </DotLine>
      </div>
      <div className="flex gap-8">
        {distance === MISSING ? null : (
          <Stat label={sessionCopy.distance} value={distance} unit={units} />
        )}
        <Stat label={sessionCopy.time} value={formatDuration(durationS)} />
      </div>
      {session.steps.length > 0 ? (
        <StepsList steps={session.steps} paces={paces} units={units} />
      ) : null}
      {caption !== null && caption !== "Skipped" ? (
        <section aria-label={sessionCopy.garmin} className="flex flex-col gap-2">
          <h2 className="text-body font-semibold text-ink">{sessionCopy.garmin}</h2>
          <div className="flex flex-col gap-3 rounded-md bg-surface-1 p-4">
            <p className="text-body text-ink">{caption}</p>
            <GarminPushLine garmin={garmin} send={send} explainExpired />
          </div>
        </section>
      ) : null}
      {canChange(session, today) ? (
        <SessionActions session={session} name={name} today={today} move={move} skip={skip} />
      ) : null}
    </>
  );
}

/** A detail screen: Back top left, the session's day centered as the title. */
function SessionLayout({
  title,
  children,
  busy,
}: {
  /** Null while loading: a block at the title's height. */
  title: string | null;
  children: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <header className="relative flex min-h-11 items-center justify-center">
        <BackLink to="/plan" />
        {title === null ? (
          <div className="h-5 w-24 rounded-sm bg-surface-2" />
        ) : (
          <h1 className="text-title text-ink">{title}</h1>
        )}
      </header>
      {children}
    </div>
  );
}

/** The name, the two stats, three steps and the Garmin card at their loaded heights. */
function SessionSkeleton() {
  return (
    <SessionLayout title={null} busy>
      <div role="status" aria-label={sessionCopy.loading} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex h-5.5 items-center">
            <div className="h-4 w-28 rounded-sm bg-surface-2" />
          </div>
          <div className="flex h-4 items-center">
            <div className="h-3 w-16 rounded-sm bg-surface-2" />
          </div>
        </div>
        <div className="flex gap-8">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1">
              <div className="h-4 w-14 rounded-sm bg-surface-2" />
              <div className="h-8.5 w-20 rounded-sm bg-surface-2" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex h-5.5 items-center">
            <div className="h-4 w-12 rounded-sm bg-surface-2" />
          </div>
          <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="flex flex-col gap-1 py-3">
                <div className="flex h-5.5 items-center justify-between">
                  <div className="h-4 w-20 rounded-sm bg-surface-2" />
                  <div className="h-4 w-12 rounded-sm bg-surface-2" />
                </div>
                <div className="flex h-4 items-center">
                  <div className="h-3 w-32 rounded-sm bg-surface-2" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex h-5.5 items-center">
            <div className="h-4 w-14 rounded-sm bg-surface-2" />
          </div>
          <div className="h-26 rounded-md bg-surface-1" />
        </div>
      </div>
    </SessionLayout>
  );
}
