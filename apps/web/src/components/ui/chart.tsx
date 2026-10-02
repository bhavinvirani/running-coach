// shadcn new-york-v4 chart, restyled to tokens. Changes from the copy: dark only (no theme map),
// token classes for grid, axes, cursor and tooltip, no shadow or mono font, indicators and legend swatches
// drawn as SVG fills instead of inline styles (lint bans the style prop), and a `valueFormatter` so tooltip
// values go through src/lib/format.ts instead of toLocaleString.
import * as React from "react";
import * as RechartsPrimitive from "recharts";
import type { TooltipValueType } from "recharts";
import { cn } from "@/lib/cn";

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;
type TooltipNameType = number | string;

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
    /** A token reference, e.g. "var(--color-chart-series)". */
    color?: string;
  }
>;

type ChartContextProps = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);

  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }

  return context;
}

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
    <ChartContext.Provider value={{ config }}>
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
    </ChartContext.Provider>
  );
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
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
};

function Swatch({
  color,
  indicator,
}: {
  color: string | undefined;
  indicator: "line" | "dot" | "dashed";
}) {
  if (indicator === "dot") {
    return (
      <svg aria-hidden="true" viewBox="0 0 10 10" className="size-2.5 shrink-0">
        <rect width="10" height="10" rx="2" fill={color} />
      </svg>
    );
  }
  if (indicator === "line") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 4 10"
        preserveAspectRatio="none"
        className="w-1 shrink-0 self-stretch"
      >
        <rect width="4" height="10" rx="1" fill={color} />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 2 10"
      preserveAspectRatio="none"
      className="w-0.5 shrink-0 self-stretch"
    >
      <line x1="1" x2="1" y1="0" y2="10" stroke={color} strokeWidth="2" strokeDasharray="2 2" />
    </svg>
  );
}

function payloadFill(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null && "fill" in payload) {
    return typeof payload.fill === "string" ? payload.fill : undefined;
  }
  return undefined;
}

const ChartTooltip = RechartsPrimitive.Tooltip;

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  valueFormatter = String,
  color,
  nameKey,
  labelKey,
}: React.ComponentProps<typeof RechartsPrimitive.Tooltip> &
  React.ComponentProps<"div"> & {
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: "line" | "dot" | "dashed";
    nameKey?: string;
    labelKey?: string;
    /** Formats a numeric value with src/lib/format.ts. */
    valueFormatter?: (value: number) => string;
  } & Omit<
    RechartsPrimitive.DefaultTooltipContentProps<TooltipValueType, TooltipNameType>,
    "accessibilityLayer"
  >) {
  const { config } = useChart();

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null;
    }

    const [item] = payload;
    const key = configKey(labelKey, item?.dataKey, item?.name);
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value =
      !labelKey && typeof label === "string" ? (config[label]?.label ?? label) : itemConfig?.label;

    if (labelFormatter) {
      return (
        <div className={cn("font-medium", labelClassName)}>{labelFormatter(value, payload)}</div>
      );
    }

    if (!value) {
      return null;
    }

    return <div className={cn("font-medium", labelClassName)}>{value}</div>;
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  if (!active || !payload?.length) {
    return null;
  }

  const nestLabel = payload.length === 1 && indicator !== "dot";

  return (
    <div
      className={cn(
        "grid min-w-32 items-start gap-1.5 rounded-sm border border-line bg-surface-1 px-2.5 py-1.5 text-caption text-ink",
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = configKey(nameKey, item.name, item.dataKey);
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const indicatorColor = color ?? payloadFill(item.payload) ?? item.color;

            return (
              <div
                key={index}
                className={cn(
                  "flex w-full flex-wrap items-stretch gap-2 [&>svg]:text-ink-2",
                  indicator === "dot" && "items-center",
                )}
              >
                {formatter && item?.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload as never)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && <Swatch color={indicatorColor} indicator={indicator} />
                    )}
                    <div
                      className={cn(
                        "flex flex-1 justify-between gap-2 leading-none",
                        nestLabel ? "items-end" : "items-center",
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-ink-2">{itemConfig?.label ?? item.name}</span>
                      </div>
                      {item.value != null && (
                        <span className="font-medium text-ink">
                          {typeof item.value === "number"
                            ? valueFormatter(item.value)
                            : String(item.value)}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
}: React.ComponentProps<"div"> & {
  hideIcon?: boolean;
  nameKey?: string;
} & RechartsPrimitive.DefaultLegendContentProps) {
  const { config } = useChart();

  if (!payload?.length) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-4 text-caption text-ink-2",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className,
      )}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item, index) => {
          const key = configKey(nameKey, item.dataKey);
          const itemConfig = getPayloadConfigFromPayload(config, item, key);

          return (
            <div
              key={index}
              className="flex items-center gap-1.5 [&>svg]:size-3 [&>svg]:text-ink-2"
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <svg aria-hidden="true" viewBox="0 0 8 8" className="size-2 shrink-0">
                  <rect width="8" height="8" rx="2" fill={item.color} />
                </svg>
              )}
              {itemConfig?.label}
            </div>
          );
        })}
    </div>
  );
}

// The first key that is a string or number; a function dataKey cannot name a config entry.
function configKey(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
  }
  return "value";
}

// Helper to extract item config from a payload.
function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const payloadPayload =
    "payload" in payload && typeof payload.payload === "object" && payload.payload !== null
      ? payload.payload
      : undefined;

  let configLabelKey: string = key;

  if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
    configLabelKey = payload[key as keyof typeof payload];
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload];
  }

  return configLabelKey in config ? config[configLabelKey] : config[key];
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
};
