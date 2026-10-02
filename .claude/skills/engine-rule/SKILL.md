---
name: engine-rule
description: Use when adding or changing a training rule in packages/engine (volume, intensity, taper, paces, re-entry), test first.
---
# Engine rule

Copy `packages/engine/src/rules/weekly-volume.ts` and `weekly-volume.test.ts`.

1. Test first: boundary values from SPEC.md "Plan engine" (the cap, one below, one above) and a fast-check property over generated weeks. Run it and watch it fail.
2. One pure function in `src/rules/<rule>.ts`; its constants in `src/constants.ts` with a source comment.
3. Wire it into `src/plan/generate.ts` or `src/plan/validate-delta.ts`, and add the rule to the whole-plan property test in `src/plan/generate.test.ts`.
4. Conflicts the user must see are returned, never thrown.
5. `pnpm --filter @running-coach/engine test` green with full branch coverage on the new file.
