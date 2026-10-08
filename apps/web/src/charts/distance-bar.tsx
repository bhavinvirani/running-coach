// A hand-made SVG like SplitBars: the fill's width is a percent of the track, set as an SVG attribute
// because lint bans inline styles and arbitrary classes. One bar needs no axis, so Recharts would add only
// its weight.

// SVG attributes cannot read tokens.css: this mirrors --radius-sm (6px), half the 12 px bar, so both ends
// are round.
const BAR_RADIUS = 6;

type DistanceBarProps = {
  distanceM: number;
  /** The distance the bar fills at; past it the bar stays full. */
  goalM: number;
};

/**
 * How far a pair of shoes has run against its retire distance, chart-series on a surface-2 track (accent
 * stays chrome). Hidden from screen readers: the text beside it carries both numbers, and the words for a
 * pair past its goal.
 */
export function DistanceBar({ distanceM, goalM }: DistanceBarProps) {
  const percent = goalM > 0 ? Math.min(100, Math.round((distanceM / goalM) * 1000) / 10) : 0;

  return (
    <svg aria-hidden="true" className="h-3 w-full">
      <rect x="0" y="0" width="100%" height="100%" rx={BAR_RADIUS} className="fill-surface-2" />
      {percent > 0 ? (
        <rect
          x="0"
          y="0"
          width={`${percent}%`}
          height="100%"
          rx={BAR_RADIUS}
          className="fill-chart-series"
        />
      ) : null}
    </svg>
  );
}
