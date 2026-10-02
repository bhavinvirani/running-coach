---
paths:
  - "apps/web/**"
---

# Web UI (apps/web)

Data first: big tabular figures, small sentence-case labels. Dark only. Strava and Runna are references for layout and density, not for color.

## Tokens

- Every color, type size, spacing step and radius comes from `src/styles/tokens.css`. Tailwind exposes only token utilities (`bg-surface-1`, `text-ink-2`, `border-line`, `text-figure`, `rounded-md`); `bg-red-500`, `text-sm`, `p-[13px]`, hex literals and any `style` prop fail lint.
- `accent` is the only chromatic chrome color: primary action, selected tab, focus ring, the target line in charts, and the race-practice workout type. A selected or current card gets `border-line-selected`, nothing else. `type-*` colors appear only as the bar or dot beside a workout type's name. `zone-*` only in HR zones. `good`/`bad` only for deltas and status, always with a sign or word.
- Two or three type sizes per screen: `text-figure` for the numbers that matter, `text-body` for text and table cells, `text-caption` for labels and axes. `text-title` only for the screen title; `text-figure-lg` only for one hero number on Today.
- `font-variant-numeric: tabular-nums` is set on `body`; keep it. Pace `m:ss /km`, duration `h:mm:ss` or `mm:ss`, distance one decimal plus unit, all through `src/lib/format.ts`; never format a number inline.

## Structure

- `src/screens/<name>/<name>-screen.tsx` is the route component; `use-<name>.ts` beside it composes the query and mutation hooks from `src/api/<resource>.ts` into what the screen needs; pieces go in `parts/`. Shared pieces move to `src/components/` only when a second screen uses them.
- Every screen has three states, each tested: loading (skeleton in the final layout, no spinner), empty (one sentence and one action), error (what happened and what to do, text from `src/lib/errors.ts`, plus Retry). A screen that cannot be empty says why in its doc comment (Settings). `ScreenErrorBoundary` from `src/app/screen-error-boundary.tsx` wraps each route.
- Navigation: bottom tabs Today, Plan, Progress, Settings; detail screens push with a back control top left and the screen title centered. Sync is a button on Today and runs on app open.
- shadcn components are copied into `src/components/ui/` and restyled to tokens before first use: colors, radii, shadows and sizes become token classes; structural arbitrary values the copy needs (`w-(--sidebar-width)`, `data-[state=open]:`) may stay, and lint exempts that folder alone from the arbitrary-value rule.
- Never: gradients, glassmorphism, glowing borders, shadows heavier than `shadow-none`, emoji, illustrations, icons on every row, centered hero blocks, placeholder or marketing copy, uppercase labels, animation that is not feedback to a tap.
- Buttons name the action: "Sync now", "Reconnect Garmin", "Save goal". The same verb stays through the flow and its toast.

## Data

- All server data goes through TanStack Query hooks in `src/api/`, over `src/api/client.ts` (typed fetch, `x-request-id`, problem+json → `ApiError`). Query keys come from `src/api/query-keys.ts` as `[resource, "list" | "detail", ...ids]`; mutations invalidate by resource prefix.
- Types are imported from `@running-coach/shared`; never redeclare a response shape.
- Values arrive in SI and UTC; convert at render time with the conversions in `@running-coach/shared` (`units.ts`) and the user's settings from `useSettings()` in `src/api/me.ts`, then format with `src/lib/format.ts`.
- The service worker caches the app shell only; API responses are never cached offline.

## Charts

- Only through `src/charts/*` (Recharts via the restyled shadcn `ChartContainer` in `src/components/ui/chart.tsx`, tooltip values through its `valueFormatter`): `isAnimationActive={false}`, series downsampled to 600 points with `src/lib/downsample.ts`, 2 px lines, gridlines `chart-grid`, axes in `text-caption` `ink-2`, target lines dashed `accent` with a text label, no legend for a single series, readable at 390 px. Chart screens are lazy routes.
- Route map: `react-map-gl` with the Mapbox dark style, no controls except recenter, the route in `chart-series`.

Reference (phase 5): `src/screens/settings/settings-screen.tsx`, `src/components/stat.tsx`, `src/charts/laps-chart.tsx`, `src/styles/tokens.css`.
