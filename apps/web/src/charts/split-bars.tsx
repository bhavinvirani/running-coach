// A hand-made SVG rather than Recharts: each row is its own 36 px bar whose width is a percent of the row,
// set as SVG attributes because lint bans inline styles and arbitrary classes, and a per-row chart height
// cannot come from a token class. Nothing here needs an axis, so Recharts would add only its weight.
import type { Units } from "@running-coach/shared";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatCount, formatPace, formatPaceDelta } from "@/lib/format";
import { glitchCaption, type LapPoint } from "./lap-point";
import { toSplitRows, type SplitRow } from "./split-row";

/** Laps shown before Show all: a half marathon of auto-laps still fits about one screen. */
const COLLAPSED_LAPS = 12;

type SplitBarsProps = {
  laps: readonly LapPoint[];
  unit: Units;
  /**
   * The table view of the same laps, listing the first `count`; the screen draws it, because the table
   * shows what a lap point does not carry (avg HR). It shares the bars' 12-lap cap and Show all.
   */
  table: (count: number) => ReactNode;
};

/**
 * Splits as pace bars, one row per lap: the lap number, a bar as long as the lap was fast with its pace
 * inside (the split pace bars are the one data use of accent on the run screen), and the change from the
 * lap before. The first 12 laps, then Show all; Show table switches to the screen's table.
 */
export function SplitBars({ laps, unit, table }: SplitBarsProps) {
  const [showTable, setShowTable] = useState(false);
  const [showAll, setShowAll] = useState(false);

  if (laps.length === 0) {
    return <p className="text-body text-ink-2">No laps recorded for this run.</p>;
  }

  const rows = toSplitRows(laps);
  const anyPace = rows.some((row) => row.paceSecondsPerUnit !== null && !row.gpsGlitch);
  const count = showAll ? rows.length : Math.min(rows.length, COLLAPSED_LAPS);
  const canExpand = rows.length > COLLAPSED_LAPS && (showTable || anyPace);
  const caption = glitchCaption(laps);

  return (
    <div className="flex flex-col gap-2">
      {showTable ? (
        table(count)
      ) : anyPace ? (
        <ol aria-label="Splits" className="flex flex-col">
          {rows.slice(0, count).map((row) => (
            <SplitBar key={row.index} row={row} unit={unit} />
          ))}
        </ol>
      ) : (
        <p className="text-body text-ink-2">No lap has a pace to chart.</p>
      )}
      {/* Show all on the left with the toggle, the caption under them; without Show all the caption
          takes its place, as under the other charts. */}
      <div className="flex items-center justify-between gap-3">
        {canExpand ? (
          // Pulled into the card's padding so its label lines up with the lap numbers above.
          <Button variant="ghost" className="-ml-4" onClick={() => setShowAll((all) => !all)}>
            {showAll ? "Show fewer" : `Show all ${formatCount(rows.length, "lap", "laps")}`}
          </Button>
        ) : (
          <Caption text={caption} />
        )}
        <Button variant="ghost" onClick={() => setShowTable((shown) => !shown)}>
          {showTable ? "Show chart" : "Show table"}
        </Button>
      </div>
      {canExpand && caption ? <Caption text={caption} /> : null}
    </div>
  );
}

function Caption({ text }: { text: string | null }) {
  return <p className="text-caption text-ink-2">{text}</p>;
}

function deltaClass(seconds: number): string {
  if (seconds > 0) return "text-good";
  if (seconds < 0) return "text-bad";
  return "text-ink-2";
}

function SplitBar({ row, unit }: { row: SplitRow; unit: Units }) {
  const pace = formatPace(row.paceSecondsPerUnit, unit);
  return (
    <li className="flex min-h-11 items-center gap-2">
      <span className="w-10 shrink-0 text-body text-ink-2">{row.label}</span>
      <div className="flex min-w-0 flex-1 items-center">
        {row.gpsGlitch ? (
          <span className="pl-3 text-body text-ink-2">GPS glitch</span>
        ) : row.barPercent === null ? (
          <span className="pl-3 text-body text-ink-2">{pace}</span>
        ) : (
          <svg className="h-9 w-full text-body" role="img" aria-label={pace}>
            <rect
              x="0"
              y="0"
              width={`${row.barPercent}%`}
              height="100%"
              rx="6"
              className="fill-accent"
            />
            <text x="12" y="50%" dominantBaseline="central" className="fill-on-accent">
              {pace}
            </text>
          </svg>
        )}
      </div>
      <span
        className={cn(
          "w-14 shrink-0 text-right text-body",
          row.deltaSeconds === null ? null : deltaClass(row.deltaSeconds),
        )}
      >
        {row.deltaSeconds === null ? null : formatPaceDelta(row.deltaSeconds)}
      </span>
    </li>
  );
}
