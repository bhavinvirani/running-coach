---
name: chart
description: Use when adding a chart to apps/web (laps, splits, HR zones, cadence, elevation, weekly volume) with Recharts.
---
# Chart

Copy `apps/web/src/charts/laps-chart.tsx` and `laps-chart.test.tsx`.

1. One component per chart kind in `src/charts/`; props are already-converted data plus an optional `target`.
2. Recharts through the shadcn `ChartContainer`: `isAnimationActive={false}`, `strokeWidth={2}`, gridlines `chart-grid`, axis text `text-caption` in `ink-2`, the series in `chart-series`, a second measure as a second chart in `chart-series-2` (never a second y axis), the target as a dashed `accent` `ReferenceLine` with a text label.
3. Downsample to 600 points with `src/lib/downsample.ts` before rendering; chart screens are lazy routes.
4. A `<table>` view behind a "Show table" toggle for every chart; a legend only with 2 or more series.
5. Tests: renders with seed data; renders the empty state for `[]`; a split faster than 2:00/km is marked as a GPS glitch and excluded.
6. Screenshot spec at 390 px in `e2e/screens/`.

Zone colors `zone-1` to `zone-5` appear only in the HR zones chart. Delta colors `good` and `bad` always come with a sign.
