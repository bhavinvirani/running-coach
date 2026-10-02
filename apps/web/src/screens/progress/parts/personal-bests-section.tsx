import type { DistanceKey, PersonalBest, PersonalBestsResponse } from "@running-coach/shared";
import type { ScreenState } from "@/api/screen-state";
import { longestFirst } from "@/components/best-effort-order";
import { BestEffortRow, BestEffortRowSkeleton, BestEffortTile } from "@/components/best-effort-row";
import { RetryAlert } from "@/components/retry-alert";
import { DISTANCE_KEYS, distanceLabel } from "@/lib/distance-labels";
import { formatLocalDate, formatRecordTime } from "@/lib/format";
import { type PendingBestsLine, pendingBestsLine, progressCopy } from "../progress-copy";

/** A best stays "New" for a week from the run's start. */
const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;

type PersonalBestsSectionProps = {
  state: ScreenState<PersonalBestsResponse>;
  /** When the bests were last read, as epoch ms; a best counts as new for a week before it. */
  checkedAt: number;
};

/**
 * The runner's best time at each of the eleven distances, as one row of tiles that scrolls sideways at
 * the top of Progress, so the bests take one tile's height instead of the screen: the distances with a
 * best longest first, then the ones no run has reached yet. It loads and fails on its own, so the weeks
 * below stay usable whatever happens here. While runs wait for their best efforts, a line under the
 * heading says how many are being checked, or why none are and what to do. Garmin's own records are not
 * shown: comparing with them was a one-time check of the numbers, and the tiles read cleaner without.
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

  const pending = pendingBestsLine(state.data);
  const bestByDistance = new Map(state.data.bests.map((best) => [best.distanceKey, best]));
  const tiles = longestFirst(
    DISTANCE_KEYS.map((distanceKey) => ({ distanceKey, best: bestByDistance.get(distanceKey) })),
    (tile) => tile.best !== undefined,
  );

  return (
    <>
      {pending ? <PendingLine line={pending} /> : null}
      {state.refetchError ? (
        <RetryAlert error={state.refetchError} onRetry={() => void state.refetch()} />
      ) : null}
      <BestEffortRow label={progressCopy.personalBests}>
        {tiles.map((tile) => (
          <PersonalBestTile key={tile.distanceKey} {...tile} now={checkedAt} />
        ))}
      </BestEffortRow>
    </>
  );
}

type PersonalBestTileProps = {
  distanceKey: DistanceKey;
  /** The runner's best at this distance; undefined until a run covers it. */
  best: PersonalBest | undefined;
  /** When the bests were read, as epoch ms: the instant "New" is measured from. */
  now: number;
};

/**
 * One distance: the time as Garmin would show it, New for a week and the run's local date. A best opens
 * its run; a distance not reached yet says so and opens nothing.
 */
function PersonalBestTile({ distanceKey, best, now }: PersonalBestTileProps) {
  const label = distanceLabel(distanceKey);

  if (best === undefined) {
    return (
      <BestEffortTile
        label={label}
        name={[label, progressCopy.noRunYet].join(", ")}
        noTime={progressCopy.noRunYet}
        captions={[]}
      />
    );
  }

  const time = formatRecordTime(best.timeS);
  const date = formatLocalDate(best.startLocal);
  const isNew = now - Date.parse(best.startUtc) < NEW_FOR_MS;
  const name = [label, time, date, isNew ? progressCopy.newBest : null]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <BestEffortTile
      label={label}
      name={name}
      personalBest
      chip={isNew ? progressCopy.newBest : undefined}
      time={time}
      captions={[{ text: date, dateTime: best.startLocal }]}
      href={`/runs/${best.activityId}`}
    />
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

/** The row at its loaded height (label, time, date), one block per distance, so nothing jumps on load. */
export function PersonalBestsSkeleton() {
  return <BestEffortRowSkeleton count={DISTANCE_KEYS.length} />;
}
