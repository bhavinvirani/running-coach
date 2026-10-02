---
name: ui-screen
description: Use when adding a screen or route to apps/web, with its data hook, loading, empty and error states, and tests.
---

# UI screen

Copy `apps/web/src/screens/settings/`: `settings-screen.tsx`, `use-settings.ts`, `parts/`, `settings-screen.test.tsx`.

1. Lazy route in `src/app/router.tsx` under the `authenticated` route, with `ErrorBoundary: ScreenErrorBoundary`. Tab screens render inside `src/app/tab-shell.tsx` (add the tab to `tabs`); detail screens get a back control and a centered title.
2. `use-<name>.ts` beside the screen exports `use<Name>Screen()`, which composes the hooks from `src/api/`, keyed from `src/api/query-keys.ts`; the screen receives `screenState(query)` from `src/api/screen-state.ts`, `{ data, status, error, refetchError, refetch }` as a union, so `status` narrows `data`, plus its actions, and nothing else fetches. `status` is `error` only when the first load failed; `refetchError` keeps the content with an inline alert and Retry.
3. States in this order in the file: loading skeleton in the final layout (`role="status"`, no spinner); error with `errorMessage(error)` from `src/lib/errors.ts` in `text-ink` with `role="alert"`, and Retry; empty with one sentence and one action; then the content. Settings has loading, error and content only, and its doc comment says why it cannot be empty. The empty-state reference is `apps/web/src/screens/today/` (`today-screen.tsx`, `use-today.ts`, `today-screen.test.tsx`): one sentence that says what to do plus one action button. A screen with one mutation and no query (login) may skip `use-<name>.ts`.
4. Content from tokens only: `text-figure` for the numbers that matter, `text-body`, `text-caption`; on a tab screen, `Section` cards divided by `border-line` (Settings); on a detail screen, `surface-1` cards with the heading above each (`RunSection` on the run screen); no new colors, no new sizes.
5. Tests: Vitest and Testing Library through `renderScreen` (`src/test/render.tsx`) and `stubFetch` (`src/test/fake-api.ts`) for each state and the main interaction; a Playwright flow when the issue names one (e2e-flow skill); a screenshot spec of the loaded state on seed data.
