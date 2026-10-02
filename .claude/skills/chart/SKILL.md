---
name: chart
description: Use when adding a chart to apps/web (laps, splits, HR zones, cadence, elevation, weekly volume) with Recharts.
---

# Chart

Copy `apps/web/src/charts/laps-chart.tsx` and `apps/web/src/charts/laps-chart.test.tsx`.

1. One component per chart kind in `src/charts/`; props are points built at the UI edge by a `to<Point>` helper beside the chart (`toLapPoint` in `src/charts/lap-point.ts`: meters and seconds in, the user's unit out, glitches through the shared `isGpsGlitch`) plus an optional `target`.
2. Recharts through the restyled shadcn `ChartContainer` in `src/components/ui/chart.tsx` (series colors from its `config` as token vars; it keeps only `ChartContainer` and `ChartStyle`, so a chart that needs a tooltip or legend adds shadcn's back, restyled, with values through `src/lib/format.ts`): `isAnimationActive={false}`, `strokeWidth={2}`, gridlines `chart-grid`, axis text `text-caption` in `ink-2`, the series in `chart-series`, a second measure as a second chart in `chart-series-2` (never a second y axis), the target as a dashed `accent` `ReferenceLine` with a text label. The one exception is `src/charts/split-bars.tsx`, a hand-drawn SVG list (one bar per lap, the pace inside, widths as SVG percentage attributes, no axis; its bar radius and label inset are two named constants mirroring `--radius-sm` and spacing step 3): a per-row height cannot come from a token class, so `ChartContainer` cannot draw it.
3. Downsample to 600 points with `src/lib/downsample.ts` before rendering; chart screens are lazy routes.
4. A `<table>` view behind a "Show table" toggle for every chart (`tableToggle={false}` only when the screen lists the same rows in its own table right under the chart); a legend only with 2 or more series.
5. Tests: renders with test data; renders the empty state for `[]`; points built with `toLapPoint` from meters and seconds: a 1:50/km lap and a 3:00/mi lap are marked as GPS glitches (`GPS_GLITCH_PACE_S_PER_KM`) and excluded, a treadmill lap without distance has no pace and is no glitch; the table toggle.
6. Screenshot spec at 390 px in `e2e/screens/` once a screen shows the chart.

Zone colors `zone-1` to `zone-5` appear only in the HR zones chart. Delta colors `good` and `bad` always come with a sign.
