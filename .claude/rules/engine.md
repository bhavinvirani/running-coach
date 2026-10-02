---
paths:
  - "packages/engine/**"
---
# Engine (packages/engine)

- Pure TypeScript: no `node:` imports, fetch, `Date.now`, `Math.random`, or any package that does I/O. The current date and any randomness come in as arguments. Lint enforces the boundary.
- Input and output shapes are the zod schemas in `@running-coach/shared`; the engine never defines its own copies.
- Every number in a plan comes from a rule in `src/rules/<rule>.ts`: one pure function per file, constants in `src/constants.ts` with a one-line source comment beside each (Daniels VDOT, the 10% rule, ACWR).
- The rule list is SPEC.md "Plan engine": VDOT paces; +10% weekly volume and no run over 110% of the 30-day longest; down week every 4th; 80% easy time; at most 2 quality sessions at 3 runs a week; 48 h between hard days; long run at most 30% of the week or 150 min; T 10%, I 8%, R 5% of weekly km per session; taper 2 weeks (3 marathon) cutting 40 to 60%; minimum plan length by distance; missed runs dropped; re-entry 70% after 7 days off and 50% after 14; conflicts reported, never bent.
- Deterministic: same inputs, same plan, byte for byte. Each rule has unit tests on its boundary values and a fast-check property that holds over generated plans.
- Test first: the failing test in `src/rules/<rule>.test.ts` exists before the implementation. A rule without a test does not merge.
- Claude never calls the engine and the engine never calls Claude. `validateDelta(plan, delta)` accepts, clamps or rejects a proposed change; `applyDelta` produces the next plan version; only the API's plan service persists it.
- User-facing conflicts (goal exceeds the caps at the chosen days per week) are return values `{ ok: false, conflict }`, never exceptions. Throw only for programmer errors.

Reference (phase 5): `src/rules/weekly-volume.ts`, `src/rules/weekly-volume.test.ts`.
