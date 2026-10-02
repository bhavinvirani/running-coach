import type { DistanceKey, GarminRecord, PersonalBestsResponse } from "@running-coach/shared";
import type { ScreenState } from "@/api/screen-state";
import { RetryAlert } from "@/components/retry-alert";
import { cn } from "@/lib/cn";
import { DISTANCE_KEYS } from "@/lib/distance-labels";
import { type PendingBestsLine, pendingBestsLine, progressCopy } from "../progress-copy";
import { PersonalBestBadge, TILE_CARD, TILE_SLOT } from "./personal-best-badge";

type PersonalBestsSectionProps = {
  state: ScreenState<PersonalBestsResponse>;
  /** When the bests were last read, as epoch ms; a best counts as new for a week before it. */
  checkedAt: number;
};

/**
 * The runner's best time at each of the eleven distances, shortest first, as one row of tiles that
 * scrolls sideways at the top of Progress, so the bests take one tile's height instead of the screen.
 * It loads and fails on its own, so the weeks below stay usable whatever happens here. While runs wait
 * for their best efforts, a line under the heading says how many are being checked, or why none are and
 * what to do. Under the row, when Garmin's records are in, a caption says why only some tiles carry one.
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
      <ul aria-label={progressCopy.personalBests} className={cn(BLEED, SCROLLER)}>
        {DISTANCE_KEYS.map((distanceKey) => (
          <PersonalBestBadge
            key={distanceKey}
            distanceKey={distanceKey}
            best={bestByDistance.get(distanceKey)}
            garminRecord={garminByDistance.get(distanceKey)}
            now={checkedAt}
          />
        ))}
      </ul>
      {garminByDistance.size > 0 ? (
        <p className="text-caption text-ink-2">{progressCopy.garminRecordsNote}</p>
      ) : null}
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

/**
 * The row bleeds to the screen's edges: -mx-4 undoes Progress's px-4 so tiles slide under the edge
 * instead of being cut at the content's padding, and px-4 puts the first tile back in line with the
 * heading. py-1 keeps a tile's focus ring inside the row, which clips what overflows it.
 */
const BLEED = "-mx-4 flex gap-3 px-4 py-1";
/** Sideways scroll that settles with a tile at the heading's edge (scroll-px-4 matches the px-4). */
const SCROLLER = "snap-x snap-mandatory scroll-px-4 overflow-x-auto";

/**
 * The row with every tile at its loaded height (label, time, date), so nothing jumps on load. Blocks, not
 * a list: a screen reader hears the loading status around it, not eleven empty items.
 */
export function PersonalBestsSkeleton() {
  return (
    <div className={cn(BLEED, "overflow-hidden")}>
      {DISTANCE_KEYS.map((distanceKey) => (
        <div key={distanceKey} className={TILE_SLOT}>
          <div className={TILE_CARD}>
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
