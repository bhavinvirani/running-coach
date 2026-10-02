import type { DistanceKey, GarminRecord, PersonalBestsResponse } from "@running-coach/shared";
import type { ReactNode } from "react";
import type { ScreenState } from "@/api/screen-state";
import { RetryAlert } from "@/components/retry-alert";
import { cn } from "@/lib/cn";
import { DISTANCE_KEYS } from "@/lib/distance-labels";
import { type PendingBestsLine, pendingBestsLine, progressCopy } from "../progress-copy";
import { PersonalBestBadge } from "./personal-best-badge";

type PersonalBestsSectionProps = {
  state: ScreenState<PersonalBestsResponse>;
  /** When the bests were last read, as epoch ms; a best counts as new for a week before it. */
  checkedAt: number;
};

/**
 * The runner's best time at each of the eleven distances, shortest first, on one card at the top of
 * Progress. It loads and fails on its own, so the weeks below stay usable whatever happens here. While
 * runs wait for their best efforts, a line under the heading says how many are being checked, or why
 * none are and what to do.
 */
export function PersonalBestsSection({ state, checkedAt }: PersonalBestsSectionProps) {
  return (
    <section aria-label={progressCopy.personalBests} className="flex flex-col gap-2">
      <h2 className="text-body font-semibold text-ink">{progressCopy.personalBests}</h2>
      <PersonalBestsContent state={state} checkedAt={checkedAt} />
    </section>
  );
}

function PersonalBestsContent({ state, checkedAt }: PersonalBestsSectionProps) {
  if (state.status === "pending") {
    return (
      <div role="status" aria-label={progressCopy.loadingPersonalBests}>
        <PersonalBestsSkeleton />
      </div>
    );
  }

  if (state.status === "error") {
    return <RetryAlert error={state.error} onRetry={() => void state.refetch()} />;
  }

  const { bests, garmin } = state.data;
  const pending = pendingBestsLine(state.data);
  const bestByDistance = new Map(bests.map((best) => [best.distanceKey, best]));
  const garminByDistance = new Map<DistanceKey, GarminRecord>(
    (garmin?.records ?? []).map((record) => [record.distanceKey, record]),
  );

  return (
    <>
      {pending ? <PendingLine line={pending} /> : null}
      {state.refetchError ? (
        <RetryAlert error={state.refetchError} onRetry={() => void state.refetch()} />
      ) : null}
      <BadgeGrid>
        {DISTANCE_KEYS.map((distanceKey, position) => (
          <PersonalBestBadge
            key={distanceKey}
            distanceKey={distanceKey}
            best={bestByDistance.get(distanceKey)}
            garminRecord={garminByDistance.get(distanceKey)}
            now={checkedAt}
            className={rowLine(position)}
          />
        ))}
      </BadgeGrid>
    </>
  );
}

/**
 * A check stopped or held back for a known reason reads as an error sentence, like a failed import; else a
 * caption.
 */
function PendingLine({ line }: { line: PendingBestsLine }) {
  return line.stopped ? (
    <p role="alert" className="text-body text-ink">
      {line.text}
    </p>
  ) : (
    <p className="text-caption text-ink-2">{line.text}</p>
  );
}

/** Two columns on one card, so the eleven times fit a phone without a scroll of their own. */
const GRID = "grid grid-cols-2 gap-x-4 rounded-md bg-surface-1 px-4 py-1";

function BadgeGrid({ children }: { children: ReactNode }) {
  return <ul className={GRID}>{children}</ul>;
}

function rowLine(position: number): string | undefined {
  return position >= 2 ? "border-t border-line" : undefined;
}

/**
 * The card with every badge at its loaded height (label, time, date), so nothing jumps on load. Blocks,
 * not a list: a screen reader hears the loading status around it, not eleven empty items.
 */
export function PersonalBestsSkeleton() {
  return (
    <div className={GRID}>
      {DISTANCE_KEYS.map((distanceKey, position) => (
        <div key={distanceKey} className={cn("py-3", rowLine(position))}>
          <div className="flex flex-col gap-0.5 py-1">
            <div className="flex h-4 items-center">
              <div className="h-3 w-10 rounded-sm bg-surface-2" />
            </div>
            <div className="flex h-8.5 items-center">
              <div className="h-7 w-20 rounded-sm bg-surface-2" />
            </div>
            <div className="flex h-4 items-center">
              <div className="h-3 w-18 rounded-sm bg-surface-2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
