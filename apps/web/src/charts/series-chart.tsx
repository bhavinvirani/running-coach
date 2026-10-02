import type { Units } from "@running-coach/shared";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { downsample } from "@/lib/downsample";
import {
  elevationUnitLabel,
  formatCadence,
  formatDistance,
  formatElevationValue,
} from "@/lib/format";
import { seriesStretches, type SeriesKind, type SeriesPoint } from "./series-point";

type SeriesChartProps = {
  points: readonly SeriesPoint[];
  unit: Units;
  kind: SeriesKind;
};

const chartConfig = {
  value: { label: "Value", color: "var(--color-chart-series)" },
} satisfies ChartConfig;

type KindCopy = {
  name: string;
  empty: string;
  /** What the y axis measures, under the chart. */
  measure: (unit: Units) => string;
  /** The unit in the table header. */
  unitLabel: (unit: Units) => string;
  format: (value: number) => string;
};

const kinds: Record<SeriesKind, KindCopy> = {
  cadence: {
    name: "Cadence",
    empty: "No cadence recorded.",
    measure: () => "Steps per minute",
    unitLabel: () => "spm",
    format: formatCadence,
  },
  elevation: {
    name: "Elevation",
    empty: "No elevation recorded.",
    measure: (unit) => (unit === "km" ? "Meters above sea level" : "Feet above sea level"),
    unitLabel: elevationUnitLabel,
    format: formatElevationValue,
  },
};

const DISTANCE_STEPS = [0.5, 1, 2, 5, 10, 20, 50];
// From 5: a 1-step axis would turn 2 spm of noise or a 3 m rise into a cliff.
const VALUE_STEPS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000];
const MAX_INTERVALS = 4;

/** Distance ticks from 0 on round steps, at most 5 intervals so "10.0 km" labels fit at 390 px. */
function distanceTicks(max: number): number[] {
  const step = DISTANCE_STEPS.find((candidate) => max / candidate <= 5) ?? 100;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + 1e-9; tick += step) ticks.push(tick);
  return ticks;
}

/**
 * Value axis on round steps around the data, at most 4 intervals. Cadence never starts at 0: every point
 * is above it, and a 0 tick would read as the dash for a missing cadence.
 */
function valueAxis(
  values: number[],
  kind: SeriesKind,
): { low: number; high: number; ticks: number[] } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  let low = 0;
  let high = 0;
  let step = 1;
  for (const candidate of VALUE_STEPS) {
    step = candidate;
    low = Math.floor(min / step) * step;
    if (kind === "cadence") low = Math.max(step, low);
    high = Math.max(Math.ceil(max / step) * step, low + step);
    if ((high - low) / step <= MAX_INTERVALS) break;
  }
  const ticks: number[] = [];
  for (let tick = low; tick <= high; tick += step) ticks.push(tick);
  return { low, high, ticks };
}

/**
 * One measure of the run (cadence or elevation) as a line over distance in the user's unit, at most 600
 * points. The table gives one average per km or mi instead of every sample.
 */
export function SeriesChart({ points, unit, kind }: SeriesChartProps) {
  const [showTable, setShowTable] = useState(false);
  const copy = kinds[kind];

  if (points.length === 0) {
    return <p className="text-body text-ink-2">{copy.empty}</p>;
  }

  const furthest = Math.max(...points.map((point) => point.distanceInUnit));
  if (furthest <= 0) {
    // A treadmill without a footpod: the samples exist but there is no distance to lay them along.
    return (
      <p className="text-body text-ink-2">
        No distance recorded to chart {copy.name.toLowerCase()} over.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {showTable ? (
        <SeriesTable points={points} unit={unit} copy={copy} />
      ) : (
        <SeriesLine points={points} furthest={furthest} unit={unit} kind={kind} copy={copy} />
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption text-ink-2">{copy.measure(unit)}</p>
        <Button variant="ghost" onClick={() => setShowTable((shown) => !shown)}>
          {showTable ? "Show chart" : "Show table"}
        </Button>
      </div>
    </div>
  );
}

type SeriesLineProps = {
  points: readonly SeriesPoint[];
  furthest: number;
  unit: Units;
  kind: SeriesKind;
  copy: KindCopy;
};

function SeriesLine({ points, furthest, unit, kind, copy }: SeriesLineProps) {
  const charted = downsample(points, (point) => point.value);
  const axis = valueAxis(
    charted.map((point) => point.value),
    kind,
  );

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-40 w-full"
      role="img"
      aria-label={`${copy.name} chart`}
    >
      {/* No keyboard layer: there is no tooltip to move through; the table is the accessible view. */}
      <LineChart
        data={charted}
        margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
        accessibilityLayer={false}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="distanceInUnit"
          type="number"
          domain={[0, furthest]}
          ticks={distanceTicks(furthest)}
          interval={0}
          tickFormatter={(value: number) => formatDistance(value, unit)}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis
          domain={[axis.low, axis.high]}
          ticks={axis.ticks}
          interval={0}
          allowDataOverflow
          tickFormatter={(value: number) => copy.format(value)}
          tickLine={false}
          axisLine={false}
          width={44}
        />
        <Line
          dataKey="value"
          type="linear"
          stroke="var(--color-value)"
          strokeWidth={2}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

function SeriesTable({
  points,
  unit,
  copy,
}: {
  points: readonly SeriesPoint[];
  unit: Units;
  copy: KindCopy;
}) {
  return (
    <table className="w-full text-body">
      <caption className="sr-only">{copy.name}</caption>
      <thead>
        <tr className="text-caption text-ink-2">
          <th scope="col" className="py-2 text-left font-normal">
            Up to
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            {copy.name} {copy.unitLabel(unit)}
          </th>
        </tr>
      </thead>
      <tbody>
        {seriesStretches(points).map((stretch) => (
          <tr key={stretch.upTo} className="border-t border-line">
            <td className="py-2">{formatDistance(stretch.upTo, unit)}</td>
            <td className="py-2 text-right">{copy.format(stretch.average)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
