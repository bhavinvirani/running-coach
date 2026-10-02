---
name: ui-screen
description: Use when adding a screen or route to apps/web, with its data hook, loading, empty and error states, and tests.
---
# UI screen

Copy `apps/web/src/screens/settings/`: `settings-screen.tsx`, `use-settings.ts`, `parts/`, `settings-screen.test.tsx`.

1. Lazy route in `src/app/router.tsx`. Tab screens render inside the tab shell; detail screens get a back control and a centered title.
2. `use-<name>.ts` beside the screen composes the hooks from `src/api/`, keyed from `src/api/query-keys.ts`; the screen receives `{ data, status, error, refetch }` and nothing else fetches.
3. Three states, in this order in the file: loading skeleton in the final layout; empty with one sentence and one action; error with `errorMessage(error)` and Retry. Then the content.
4. Content from tokens only: `text-figure` for the numbers that matter, `text-body`, `text-caption`; sections separated by `border-line`; no new colors, no new sizes.
5. Tests: Vitest and Testing Library for the three states and the main interaction; a Playwright flow when the issue names one (e2e-flow skill); a screenshot spec of the loaded state on seed data.
