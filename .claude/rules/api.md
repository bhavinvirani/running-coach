---
paths:
  - "apps/api/**"
---

# API (apps/api)

## Layout

- `src/routes/<resource>.ts`: one Express router per resource. Parse `req.body`, `req.params` and `req.query` with `parse(schema, value)` and schemas from `@running-coach/shared`, call one service function, send through `respond(res, schema, data)` (both in `src/lib/http.ts`) so the output is parsed too. No database access, no fetch, no business logic in a route.
- `src/services/<name>.ts`: business logic and the only layer that uses `db`, `garminClient` or `coach`. Functions take plain arguments, return plain data, throw `DomainError`.
- `src/jobs/<name>.ts`: pg-boss handlers (background-job skill). `src/garmin/client.ts`: the only caller of the Python service; `src/garmin/process.ts` spawns it and restarts it with backoff. `src/coach/`: the only caller of Claude. `src/auth/`: Better Auth, its handler and `requireUser`. `src/lib/`: `errors.ts`, `logger.ts`, `crypto.ts`, `config.ts`, `http.ts`, `locks.ts`, `lock-key.ts`, `lifecycle.ts` (readiness checks, shutdown hooks), `paths.ts`, `local-date.ts`.
- One process: `src/index.ts` boots in order config (validated on import) → migrations → owner seed (when `OWNER_*` are set) → Garmin service child process → pg-boss and its workers → listen, and shuts down in reverse. `/health` answers 200 once listening and 503 while a readiness check (the Garmin child) fails. A separate worker entrypoint is deferred (#16).

## Errors

- Expected failures throw `new DomainError(code, status, detail?, { retryAfterSeconds?, cause? })` with a code from `packages/shared/src/error-codes.ts`. Never throw strings or bare `Error` for expected cases.
- One middleware in `src/lib/errors.ts` renders problem+json `{ type, title, status, code, detail?, requestId, retryAfterSeconds?, issues? }`, with a `Retry-After` header when `retryAfterSeconds` is set. Unknown errors become 500 with code `internal`, logged with the stack; the response never includes a stack or an upstream message. zod failures at the edge become 400 with code `validation` and `issues` `[{ path, message }]`.
- 401 means only "no session" (the web app logs out on it): Garmin login problems (`garmin_auth_expired`, `garmin_not_connected`) are 409.

## External calls

- Garmin service: timeout 60 s for sync, 20 s otherwise; `fetchJson` retries twice with backoff and jitter on connection errors and 5xx; never on 4xx or a timeout. A 429 is never retried immediately: the client throws `garmin_rate_limited` with `retryAfterSeconds`, and only a job may reschedule itself after that delay (background-job skill). Every call for a user runs inside `withUserLock(userId)` from `src/lib/locks.ts` (a transaction-scoped Postgres advisory lock taken on its own small pool, so waiting callers never hold the app pool's connections); when the bundle in a response, or in a Garmin-service error's `tokenBundle`, differs from the one sent, write it back before releasing the lock.
- Claude: timeout 60 s (`CLAUDE_TIMEOUT_MS`); one retry with jitter on 429, 529, 5xx or a dropped connection, on the fallback model; never on a timeout. Details in the coach-prompts rule.
- Every outgoing request carries `x-request-id` from the current request, or `job-<id>` in a job (`withRequestId`).

## Config and secrets

- `src/lib/config.ts` reads every env var once through a zod schema and exits at boot on a missing or invalid value. Nothing else reads `process.env`; the Garmin child gets only the allowlisted system variables from `inheritedEnv()`.
- `encrypt(plaintext, userId)` / `decrypt(ciphertext, userId)` in `src/lib/crypto.ts`: AES-256-GCM with `MASTER_KEY`, the user id as AAD, `v1:` prefix on the ciphertext. Decrypt inside the service function that needs the value and never return a secret from a route, not even masked.
- Logger: pino, JSON lines, `redact` for `tokenBundle`, `token`, `password`, `apiKey`, `authorization`, `cookie`, `set-cookie`, `email`, `x-garmin-secret`. Log ids, counts and durations, never activity payloads.

## Auth and limits

- Better Auth owns `/api/auth/*` through `src/auth/handler.ts`, which turns its errors into problem+json; sign-up is off; the owner is created by `pnpm seed:owner` or at boot from `OWNER_*`. Every other `/api` route sits behind `requireUser` in `src/routes/index.ts` and reads `req.user.id`; no route accepts a user id from the client.
- In-memory rate limits on `/api/auth/*` (10 per 60 s per client IP from `req.ip` with `trust proxy` 1, `/get-session` exempt, on in every `NODE_ENV`) and `/api/sync` (6/min/user). The cron endpoint compares `CRON_SECRET` with `timingSafeEqual`.
- CORS: `APP_URL` only, credentials on. Helmet defaults. JSON body limit 1 MB.

## Serving the SPA

- Static files from `apps/web/dist`: immutable cache for hashed assets, `no-cache` for `index.html` and the service worker; unknown non-API paths return `index.html`.

Reference (phase 5): `src/routes/me.ts`, `src/services/settings.ts`, `test/routes/me.test.ts`.
