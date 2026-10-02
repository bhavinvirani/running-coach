import type { HrZoneTime } from "@running-coach/shared";
import { useState } from "react";
import { Bar, BarChart, LabelList, Rectangle, XAxis, YAxis, type BarShapeProps } from "recharts";
import { Button } from "@/components/ui/button";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { formatDuration, formatHeartRate, formatPercent } from "@/lib/format";

type HrZonesChartProps = {
  zones: readonly HrZoneTime[];
};

// The only place the zone tokens appear (web-ui.md).
const chartConfig = {
  z1: { label: "Zone 1", color: "var(--color-zone-1)" },
  z2: { label: "Zone 2", color: "var(--color-zone-2)" },
  z3: { label: "Zone 3", color: "var(--color-zone-3)" },
  z4: { label: "Zone 4", color: "var(--color-zone-4)" },
  z5: { label: "Zone 5", color: "var(--color-zone-5)" },
} satisfies ChartConfig;

type Row = {
  zone: number;
  /** "Z3 137+": the zone and the bpm it starts at. */
  label: string;
  seconds: number;
  duration: string;
  fill: string;
};

function zoneLabel(zone: HrZoneTime): string {
  const from = formatHeartRate(zone.lowBpm);
  return zone.lowBpm > 0 ? `Z${zone.zone} ${from}+` : `Z${zone.zone}`;
}

function toRows(zones: readonly HrZoneTime[]): Row[] {
  return [...zones]
    .sort((a, b) => a.zone - b.zone)
    .map((zone) => ({
      zone: zone.zone,
      label: zoneLabel(zone),
      seconds: zone.seconds,
      duration: formatDuration(zone.seconds),
      fill: `var(--color-z${zone.zone})`,
    }));
}

/** Each bar in its zone's color; Recharts 3 deprecates Cell, so the color comes through the shape. */
function ZoneBar(props: BarShapeProps) {
  const row = props.payload as Row;
  return <Rectangle {...props} fill={row.fill} />;
}

/**
 * Time in each of Garmin's five heart-rate zones as horizontal bars, zone 1 at the top, each labelled with
 * its time. No gridlines or value axis: the time is written on every bar. At most five bars, so nothing
 * to downsample. The table adds each zone's share of the run.
 */
export function HrZonesChart({ zones }: HrZonesChartProps) {
  const [showTable, setShowTable] = useState(false);
  const rows = toRows(zones);
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);

  if (rows.length === 0 || total <= 0) {
    return <p className="text-body text-ink-2">No time in heart rate zones recorded.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {showTable ? <ZonesTable rows={rows} total={total} /> : <ZoneBars rows={rows} />}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => setShowTable((shown) => !shown)}>
          {showTable ? "Show chart" : "Show table"}
        </Button>
      </div>
    </div>
  );
}

function ZoneBars({ rows }: { rows: Row[] }) {
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-44 w-full"
      role="img"
      aria-label="Heart rate zones chart"
    >
      {/* No keyboard layer: there is no tooltip to move through; the table is the accessible view. */}
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ top: 0, right: 56, bottom: 0, left: 0 }}
        barCategoryGap={6}
        accessibilityLayer={false}
      >
        <XAxis type="number" dataKey="seconds" hide domain={[0, "dataMax"]} />
        <YAxis
          type="category"
          dataKey="label"
          tickLine={false}
          axisLine={false}
          width={64}
          interval={0}
        />
        <Bar
          dataKey="seconds"
          shape={ZoneBar}
          radius={2}
          isAnimationActive={false}
          minPointSize={2}
        >
          <LabelList
            dataKey="duration"
            position="right"
            offset={8}
            className="fill-ink-2 text-caption"
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

function ZonesTable({ rows, total }: { rows: Row[]; total: number }) {
  return (
    <table className="w-full text-body">
      <caption className="sr-only">Heart rate zones</caption>
      <thead>
        <tr className="text-caption text-ink-2">
          <th scope="col" className="py-2 text-left font-normal">
            Zone
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            Time
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.zone} className="border-t border-line">
            <td className="py-2">{row.label}</td>
            <td className="py-2 text-right">{row.duration}</td>
            <td className="py-2 text-right">{formatPercent(row.seconds / total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
