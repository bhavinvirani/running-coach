import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { PbDot } from "./pb-chip";

/**
 * The row bleeds to the screen's edges: -mx-4 undoes the screen's px-4 so tiles slide under the edge
 * instead of being cut at the content's padding, and px-4 puts the first tile back in line with the
 * heading. py-1 keeps a tile's focus ring inside the row, which clips what overflows it.
 */
const BLEED = "-mx-4 flex gap-2 px-4 py-1";
/**
 * Sideways scroll by swipe, trackpad or arrow keys, with no bar under it, that settles with a tile at the
 * heading's edge (scroll-px-4 matches the px-4). The row takes focus itself, so a keyboard reaches tiles
 * that are not links; its ring is inset, as the row's sides are the screen's.
 */
const SCROLLER =
  "snap-x snap-mandatory scroll-px-4 overflow-x-auto scrollbar-none focus-visible:-outline-offset-2";

/**
 * 136 px holds the widest line, measured at 390 px: "Marathon" with its dot and a New chip (115 px), or an
 * h:mm:ss time such as 4:12:30 at text-figure (110 px), inside 10 px of padding. The lines sit edge to edge
 * and the time's slot is 30 px, its digits' height plus a little, which keeps a tile with two captions
 * under 96 px. Every tile stretches to the tallest one's height, so the row stays even. `relative` holds
 * the tile's sr-only name, which is absolutely positioned, inside the scroller: placed by the page instead,
 * the names of the tiles past the screen's edge would widen the page and let it scroll sideways.
 */
const TILE_SLOT = "w-34 shrink-0 snap-start";
const TILE_CARD =
  "relative flex h-full flex-col rounded-md bg-surface-1 px-2.5 py-2 whitespace-nowrap";
const TIME_SLOT = "flex h-7.5 items-center";

type BestEffortRowProps = {
  /** The list's name for screen readers, the section's heading: "Personal bests". */
  label: string;
  /** BestEffortTile items, already in order (`longestFirst` in best-effort-order.ts). */
  children: ReactNode;
};

/**
 * Best efforts as one row of tiles that scrolls sideways, so they take one tile's height instead of the
 * screen: Personal bests on Progress, Best efforts on a run. It sits on the screen's background under its
 * heading, the tiles being cards already.
 */
export function BestEffortRow({ label, children }: BestEffortRowProps) {
  return (
    // A scrolling region must be reachable by keyboard (Safari never focuses one by itself, and Chrome
    // not once it holds a link); a list stays a list for screen readers.
    <ul aria-label={label} tabIndex={0} className={cn(BLEED, SCROLLER)}>
      {children}
    </ul>
  );
}

type TileCaption = {
  /** Already formatted: "6 Apr 2025", "Garmin 27:05", "5:30 /km". */
  text: string;
  /** For a date: its ISO value, so the line is a <time>. */
  dateTime?: string;
};

type BestEffortTileProps = {
  /** The distance, from distanceLabel: "Half". */
  label: string;
  /**
   * The tile as a screen reader hears it, one sentence in words: "Half, 1:56:12, 5:30 /km, personal best".
   * Read line by line it would run "5K" into "27:05".
   */
  name: string;
  /** Puts the PB gold dot beside the label: the runner's current best at this distance. */
  personalBest?: boolean;
  /** A short word on the right of the label line: "New", "PB". */
  chip?: string;
  /** One or two small lines under the time. */
  captions?: readonly TileCaption[];
  /** Makes the whole tile a link: a best opens its run. */
  href?: string;
} & (
  | {
      /** From formatRecordTime, cut to the second like Garmin: "1:56:12". */
      time: string;
      noTime?: never;
    }
  | {
      time?: never;
      /** For a distance without a time, the words in its place: "No run yet". */
      noTime: string;
    }
);

/**
 * One distance as a tile: the label with the PB dot and an optional chip on the right, the time as the
 * tile's figure, then its captions. Text never wraps: the width is set for the longest label and time.
 */
export function BestEffortTile(props: BestEffortTileProps) {
  const { label, name, personalBest = false, chip, captions = [], href } = props;
  const content = (
    <>
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" className="flex items-center justify-between gap-1.5">
        <span className="flex items-center gap-1.5 text-caption text-ink-2">
          {personalBest ? <PbDot /> : null}
          {label}
        </span>
        {chip ? (
          <span className="rounded-full bg-surface-2 px-1.5 text-caption font-semibold text-ink">
            {chip}
          </span>
        ) : null}
      </span>
      <span aria-hidden="true" className={TIME_SLOT}>
        {props.time === undefined ? (
          <span className="text-body text-ink-2">{props.noTime}</span>
        ) : (
          <span className="text-figure text-ink">{props.time}</span>
        )}
      </span>
      {captions.map((caption) =>
        caption.dateTime ? (
          <time
            key={caption.text}
            aria-hidden="true"
            dateTime={caption.dateTime}
            className="text-caption text-ink-2"
          >
            {caption.text}
          </time>
        ) : (
          <span key={caption.text} aria-hidden="true" className="text-caption text-ink-2">
            {caption.text}
          </span>
        ),
      )}
    </>
  );

  return (
    <li className={TILE_SLOT}>
      {href ? (
        <Link to={href} className={cn(TILE_CARD, "active:bg-surface-2")}>
          {content}
        </Link>
      ) : (
        <div className={TILE_CARD}>{content}</div>
      )}
    </li>
  );
}

/**
 * The row with `count` tiles at their loaded size (label, time, one caption), so nothing jumps on load.
 * Blocks, not a list: a screen reader hears the loading status around it, not empty items.
 */
export function BestEffortRowSkeleton({ count }: { count: number }) {
  return (
    <div className={cn(BLEED, "overflow-hidden")}>
      {Array.from({ length: count }, (_, position) => (
        <div key={position} className={TILE_SLOT}>
          <div className={TILE_CARD}>
            <div className="flex h-4 items-center">
              <div className="h-3 w-10 rounded-sm bg-surface-2" />
            </div>
            <div className={TIME_SLOT}>
              <div className="h-6 w-20 rounded-sm bg-surface-2" />
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
