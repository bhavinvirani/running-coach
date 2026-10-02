import type { Units } from "@running-coach/shared";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { downsample } from "@/lib/downsample";
import { formatDistance, formatPaceValue, paceUnitLabel } from "@/lib/format";
import type { LapPoint } from "./lap-point";

export type PaceTarget = {
  paceSecondsPerUnit: number;
  /** What the target is, e.g. "Target"; the chart appends the pace. */
  label: string;
};

type LapsChartProps = {
  laps: readonly LapPoint[];
  unit: Units;
  target?: PaceTarget;
  /** False when the screen lists every lap in a table of its own below the chart (the run screen). */
  tableToggle?: boolean;
};

const chartConfig = {
  pace: { label: "Pace", color: "var(--color-chart-series)" },
} satisfies ChartConfig;

type Row = { index: number; pace: number; bar: [number, number] };

const PACE_STEPS = [15, 30, 60, 120, 300];
const MAX_PACE_INTERVALS = 4;

/** Axis bounds on round pace steps with headroom, at most 4 intervals so labels stay legible at 390 px. */
function paceAxis(paces: number[]): { fast: number; slow: number; ticks: number[] } {
  const fastest = Math.min(...paces);
  const slowest = Math.max(...paces);
  let fast = 0;
  let slow = 0;
  let step = 0;
  for (const candidate of PACE_STEPS) {
    step = candidate;
    fast = Math.max(step, Math.floor((fastest - step / 2) / step) * step);
    slow = Math.ceil((slowest + step / 2) / step) * step;
    if ((slow - fast) / step <= MAX_PACE_INTERVALS) break;
  }
  const ticks: number[] = [];
  for (let tick = fast; tick <= slow; tick += step) ticks.push(tick);
  return { fast, slow, ticks };
}

function glitchCaption(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? "1 lap left out as a GPS glitch."
    : `${count} laps left out as GPS glitches.`;
}

/**
 * Lap paces as bars, faster drawn higher (inverted pace axis), against an optional target pace.
 * GPS glitches are left out of the chart and named in a caption; the table shows every lap.
 */
export function LapsChart({ laps, unit, target, tableToggle = true }: LapsChartProps) {
  const [showTable, setShowTable] = useState(false);

  if (laps.length === 0) {
    return <p className="text-body text-ink-2">No laps recorded for this run.</p>;
  }

  const glitches = laps.filter((lap) => lap.gpsGlitch).length;
  const charted = downsample(
    laps.filter((lap) => lap.paceSecondsPerUnit !== null && !lap.gpsGlitch),
    (lap) => lap.paceSecondsPerUnit ?? 0,
  );
  const caption = glitchCaption(glitches);

  return (
    <div className="flex flex-col gap-2">
      {showTable ? (
        <LapsTable laps={laps} unit={unit} />
      ) : charted.length === 0 ? (
        <p className="text-body text-ink-2">No lap has a pace to chart.</p>
      ) : (
        <PaceBars laps={charted} target={target} />
      )}
      {tableToggle ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-caption text-ink-2">{caption}</p>
          <Button variant="ghost" onClick={() => setShowTable((shown) => !shown)}>
            {showTable ? "Show chart" : "Show table"}
          </Button>
        </div>
      ) : caption ? (
        <p className="text-caption text-ink-2">{caption}</p>
      ) : null}
    </div>
  );
}

function PaceBars({ laps, target }: { laps: LapPoint[]; target: PaceTarget | undefined }) {
  const paces = laps.map((lap) => lap.paceSecondsPerUnit ?? 0);
  const axis = paceAxis(target ? [...paces, target.paceSecondsPerUnit] : paces);
  // Range bars from the slow edge up to the lap's pace: on the reversed axis a faster lap is taller.
  const rows: Row[] = laps.map((lap, position) => ({
    index: lap.index,
    pace: paces[position] ?? 0,
    bar: [axis.slow, paces[position] ?? 0],
  }));

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-48 w-full"
      role="img"
      aria-label="Lap pace chart"
    >
      {/* No keyboard layer: there is no tooltip to move through; the table is the accessible view. */}
      <BarChart
        data={rows}
        margin={{ top: 16, right: 4, bottom: 0, left: 0 }}
        accessibilityLayer={false}
      >
        <CartesianGrid vertical={false} />
        <XAxis dataKey="index" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          reversed
          domain={[axis.fast, axis.slow]}
          ticks={axis.ticks}
          interval={0}
          allowDataOverflow
          tickFormatter={(value: number) => formatPaceValue(value)}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <Bar
          dataKey="bar"
          fill="var(--color-pace)"
          radius={2}
          isAnimationActive={false}
          maxBarSize={32}
        />
        {target ? (
          <ReferenceLine
            y={target.paceSecondsPerUnit}
            stroke="var(--color-accent)"
            strokeDasharray="4 4"
            strokeWidth={2}
            label={{
              value: `${target.label} ${formatPaceValue(target.paceSecondsPerUnit)}`,
              position: "insideBottomLeft",
              offset: 6,
              className: "fill-accent",
            }}
          />
        ) : null}
      </BarChart>
    </ChartContainer>
  );
}

function LapsTable({ laps, unit }: { laps: readonly LapPoint[]; unit: Units }) {
  return (
    <table className="w-full text-body">
      <caption className="sr-only">Laps</caption>
      <thead>
        <tr className="text-caption text-ink-2">
          <th scope="col" className="py-2 text-left font-normal">
            Lap
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            Distance
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            Pace {paceUnitLabel(unit)}
          </th>
        </tr>
      </thead>
      <tbody>
        {laps.map((lap) => (
          <tr key={lap.index} className="border-t border-line">
            <td className="py-2 text-ink-2">{lap.index}</td>
            <td className="py-2 text-right">{formatDistance(lap.distanceInUnit, unit)}</td>
            <td className="py-2 text-right">
              {lap.gpsGlitch ? "GPS glitch" : formatPaceValue(lap.paceSecondsPerUnit)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
