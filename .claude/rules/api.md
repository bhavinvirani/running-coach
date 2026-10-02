---
paths:
  - "apps/api/**"
---
# API (apps/api)

## Layout
- `src/routes/<resource>.ts`: one Express router per resource. Parse `req.body`, `req.params` and `req.query` with schemas from `@running-coach/shared`, call one service function, send through `respond(res, schema, data)` so the output is parsed too. No database access, no fetch, no business logic in a route.
- `src/services/<name>.ts`: business logic and the only layer that uses `db`, `garminClient` or `coach`. Functions take plain arguments, return plain data, throw `DomainError`.
- `src/jobs/<name>.ts`: pg-boss handlers (background-job skill). `src/garmin/client.ts`: the only caller of the Python service. `src/coach/`: the only caller of Claude. `src/lib/`: `errors.ts`, `logger.ts`, `crypto.ts`, `config.ts`, `http.ts`, `locks.ts`.
- `src/index.ts` boots in order: config → migrations → Garmin service child process → pg-boss → Express. `/health` returns 200 only after all five; the worker entrypoint `src/worker.ts` reuses the same wiring without Express.

## Errors
- Expected failures throw `new DomainError(code, status, detail?)` with a code from `packages/shared/src/error-codes.ts`. Never throw strings or bare `Error` for expected cases.
- One middleware in `src/lib/errors.ts` renders problem+json `{ type, title, status, detail, code, requestId }`. Unknown errors become 500 with code `internal`, logged with the stack; the response never includes a stack or an upstream message. zod failures at the edge become 400 with code `validation` and the flattened issues.

## External calls
- Garmin service: timeout 60 s for sync, 20 s otherwise; retry twice with backoff and jitter on connection errors and 5xx; never on 4xx. A 429 is never retried immediately: the service throws `garmin_rate_limited` with `retryAfterSeconds`, and only a job may reschedule itself after that delay (background-job skill). Every call for a user runs inside `withUserLock(userId)` from `src/lib/locks.ts` (Postgres advisory lock); when the returned bundle differs from the one sent, write it back before releasing the lock.
- Claude: timeout 60 s; retry once on 429, 529 and 5xx with backoff. Details in the coach-prompts rule.
- Every outgoing request carries `x-request-id` from the current request or job.

## Config and secrets
- `src/lib/config.ts` reads every env var once through a zod schema and exits at boot on a missing or invalid value. Nothing else reads `process.env`.
- `encrypt(plaintext, userId)` / `decrypt(ciphertext, userId)` in `src/lib/crypto.ts`: AES-256-GCM with `MASTER_KEY`, the user id as AAD, `v1:` prefix on the ciphertext. Decrypt inside the service function that needs the value and never return a secret from a route, not even masked.
- Logger: pino, JSON lines, `redact` for `tokenBundle`, `token`, `password`, `apiKey`, `authorization`, `cookie`, `email`. Log ids, counts and durations, never activity payloads.

## Auth and limits
- Better Auth owns `/api/auth/*`; sign-up is off; the owner is created by `pnpm seed:owner`. Every other `/api` route uses `requireUser` and reads `req.user.id`; no route accepts a user id from the client.
- In-memory rate limits on `/api/auth/*` (10/min/IP) and `/api/sync` (6/min/user). The cron endpoint compares `CRON_SECRET` with `timingSafeEqual`.
- CORS: `APP_URL` only, credentials on. Helmet defaults. JSON body limit 1 MB.

## Serving the SPA
- Static files from `apps/web/dist`: immutable cache for hashed assets, `no-cache` for `index.html` and the service worker; unknown non-API paths return `index.html`.

Reference (phase 5): `src/routes/me.ts`, `src/services/settings.ts`, `test/routes/me.test.ts`.
