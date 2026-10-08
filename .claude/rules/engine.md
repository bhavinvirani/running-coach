---
paths:
  - "packages/engine/**"
---

# Engine (packages/engine)

- Pure TypeScript: no `node:` imports, fetch, `Date.now`, `new Date()`, `Math.random`, or any package that does I/O. The current date and any randomness come in as arguments. Lint enforces the boundary.
- Shapes that cross the package boundary (plan, goal, delta, activity) are the zod schemas in `@running-coach/shared`; the engine never defines its own copies. A rule's own argument and result types sit beside it (`WeeklyVolumeInput`).
- Every number in a plan comes from a rule in `src/rules/<rule>.ts`: one rule per file, pure functions only, exported from `src/index.ts`; constants in `src/constants.ts` with a one-line source comment beside each (Daniels VDOT, the 10% rule, ACWR).
- The rule list is SPEC.md "Plan engine": VDOT paces; +10% weekly volume and no run over 110% of the 30-day longest; down week every 4th, counted back from the taper; 80% easy time, strides and finishes counting as hard; at most 1 quality session at 3 runs a week, 2 from 4; 48 h between hard days; long run at most 30% of the week or 150 min; easy runs unequal, at most 85% of the long run; T 10%, I 8%, R 5% of weekly km per session; taper by calendar week from its Thursday (70% then 40% of peak, marathon 80/60/40), long run none in the last 5 days, race practice 4 days out; minimum plan length by distance; missed runs dropped; re-entry 70% after 7 days off and 50% after 14, then +10% a week, walk-run after illness or injury; coach deltas clamped to 0.5 to 1.1 inside the caps, shrink-only in the taper and race week and for a long run inside the taper bands; conflicts reported, never bent.
- Deterministic: same inputs, same plan, byte for byte. Each rule has unit tests on its boundary values and a fast-check property that holds over generated plans.
- Test first: the failing test in `src/rules/<rule>.test.ts` exists before the implementation. A rule without a test does not merge. The package `test` script runs with `--coverage`, and the root `pnpm check` runs it: 100% branches and lines on `src/rules/**`.
- Claude never calls the engine and the engine never calls Claude. `validateDelta(context, delta)` accepts, clamps or rejects a proposed change to one session and `applyDelta` returns the changed session; `reEntryPlan` eases the sessions after a break and `matchSessions` marks them done or missed. Only the API's services persist them, in place, logging coach and re-entry changes in `plan_adjustment`; a new plan version comes only from a goal save.
- User-facing conflicts (goal exceeds the caps at the chosen days per week) are return values `{ ok: false, conflict }`, never exceptions. Throw only for programmer errors.

Reference (phase 5): `src/rules/weekly-volume.ts`, `src/rules/weekly-volume.test.ts`.
