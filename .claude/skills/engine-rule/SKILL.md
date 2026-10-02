---
name: engine-rule
description: Use when adding or changing a training rule in packages/engine (volume, intensity, taper, paces, re-entry), test first.
---

# Engine rule

Copy `packages/engine/src/rules/weekly-volume.ts` and `packages/engine/src/rules/weekly-volume.test.ts`.

1. Test first: boundary values from SPEC.md "Plan engine" (the cap, one below, one above) and a fast-check property over generated weeks. Run it and watch it fail.
2. The rule in `src/rules/<rule>.ts`, pure functions only, exported from `src/index.ts`; its constants in `src/constants.ts` with a source comment.
3. Once `src/plan/` exists (slice 6), wire it into plan generation or `validateDelta` and add it to the whole-plan property test.
4. Conflicts the user must see are returned, never thrown.
5. `pnpm --filter @running-coach/engine test` green: the script runs `--coverage` with 100% branches and lines on `src/rules/**`. Thresholds sit in `vitest.config.ts` outside `defineProject`, so the root `pnpm test` ignores them.
