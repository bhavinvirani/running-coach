---
name: api-endpoint
description: Use when adding or changing an Express route in apps/api, with its zod contract, service function and integration test.
---

# API endpoint

Copy the shape of `apps/api/src/routes/me.ts`, `apps/api/src/services/settings.ts` and `apps/api/test/routes/me.test.ts`.

1. Contract first: request and response schemas in `packages/shared/src/contracts/<resource>.ts`, inferred types exported, re-exported from `packages/shared/src/index.ts`, `pnpm contract:build` run.
2. Service in `apps/api/src/services/<name>.ts`: plain arguments in, plain data out, `DomainError` for expected failures, the only place that touches `db`.
3. Route in `apps/api/src/routes/<resource>.ts`: `parse(schema, req.body)`, call the service, `respond(res, schema, data)`. Register it in `apps/api/src/routes/index.ts` behind `requireUser` unless it is `/health`, `/api/auth/*` or the cron endpoint.
4. Integration test in `apps/api/test/routes/<resource>.test.ts` on the real Postgres, through `signedInAgent(app)` and `expectProblem` from `test/helpers.ts`: success, validation 400, 401 without a session, each `DomainError` the service throws, and the corner cases the slice issue assigns to this endpoint. One `describe` per route.
5. Web side: a query or mutation hook in `apps/web/src/api/<resource>.ts` over `apiFetch` with a key from `src/api/query-keys.ts` (add the resource to `Resource` there).

Done when: environment is read only in `src/lib/config.ts`, no database access in the route, no secret in any response, problem+json on every error path, request id in every log line.
