// shadcn new-york-v4 chart, restyled to tokens and trimmed to what the app uses. Changes from the copy: dark
// only (no theme map), token classes for grid, axes and cursor, no config icons. Removed until a chart needs
// them: ChartTooltip, ChartTooltipContent and ChartLegend. When one comes back, restyle it the same way, draw
// swatches as SVG fills (lint bans the style prop) and format values with src/lib/format.ts.
import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@/lib/cn";

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    /** A token reference, e.g. "var(--color-chart-series)". */
    color?: string;
  }
>;

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
  initialDimension?: {
    width: number;
    height: number;
  };
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;

  return (
    <div
      data-slot="chart"
      data-chart={chartId}
      className={cn(
        "flex aspect-video justify-center text-caption [&_.recharts-cartesian-axis-tick_text]:fill-ink-2 [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-chart-grid [&_.recharts-curve.recharts-tooltip-cursor]:stroke-line [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-chart-grid [&_.recharts-radial-bar-background-sector]:fill-surface-2 [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-surface-2 [&_.recharts-reference-line_[stroke='#ccc']]:stroke-line [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
        className,
      )}
      {...props}
    >
      <ChartStyle id={chartId} config={config} />
      <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  );
}

/** Each config color becomes `--color-<key>` on this chart, so series reference `var(--color-<key>)`. */
function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config).filter(([, itemConfig]) => itemConfig.color);

  if (!colorConfig.length) {
    return null;
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `[data-chart=${id}] {\n${colorConfig
          .map(([key, itemConfig]) => `  --color-${key}: ${itemConfig.color};`)
          .join("\n")}\n}`,
      }}
    />
  );
}

export { ChartContainer };
