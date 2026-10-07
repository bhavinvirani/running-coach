# Running Coach

Mobile-first PWA that replaces a Runna subscription: it syncs Garmin runs, builds a training plan for any goal (5K to marathon, with or without a race date), pushes structured workouts to the watch, reviews each run with Claude as the coach, and adapts the plan. One user today (the owner); data is per-user from day one. Each user brings their own Garmin account and Claude API key; the owner can run the coach on their Claude plan instead. Hosting is $0 (two Render free web services: the app, and the coach service for the plan; Neon Postgres). SPEC.md is the one-page spec with every decision; keep it one page.

Status: the bootstrap is done (#21): every skill points at a tested reference implementation. Each session is now one slice started with `/slice N`, next `/slice 9`; the slice ends with the PR steps written in `/ship`, which the owner can also run alone.

## Repo map

| Path                 | What                                                                                                                                                | Rule                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `apps/web`           | Vite + React 19 PWA; Tailwind 4 with token-only utilities; restyled shadcn; TanStack Query; Recharts; Mapbox (slice 3)                              | `web-ui.md`         |
| `apps/web/e2e`       | Playwright flows and screenshot tests on fake seed data                                                                                             | `tests.md`          |
| `apps/api`           | Express + TypeScript: routes → services → Drizzle on Postgres; the pg-boss worker runs in the same process, the Garmin service as its child process | `api.md`            |
| `apps/api/src/db`    | Drizzle schema and committed SQL migrations                                                                                                         | `migrations.md`     |
| `apps/api/src/coach` | Claude client, versioned prompt files, output schemas, fallbacks                                                                                    | `coach-prompts.md`  |
| `apps/coach`         | Coach service: runs a prompt the API sends on the owner's Claude plan through the Claude Agent SDK; shared-secret header; second Render service     | `coach-service.md`  |
| `services/garmin`    | FastAPI over `garminconnect`, stateless, shared-secret header, bound to 127.0.0.1                                                                   | `garmin-service.md` |
| `packages/engine`    | Training rules: pure TypeScript, no I/O, test-first                                                                                                 | `engine.md`         |
| `packages/shared`    | zod contracts, error codes, units: the only source of types                                                                                         | `contracts.md`      |

Rules live in `.claude/rules/` and load by path. Each `.claude/skills/*/SKILL.md` names the reference implementation to copy from, except `neon-postgres`: Neon's own skill (Apache-2.0, pinned in `skills-lock.json`) for connection strings, branching and diagnostics. Neon is only our Postgres host, through one direct (non-pooler) URL because of advisory locks; where any skill disagrees with SPEC.md, SPEC.md wins.

## Commands (root `package.json`)

| Command                                             | Does                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                          | Postgres via docker compose, API with its worker and Garmin service, web with HMR                                                                                                                 |
| `pnpm check`                                        | typecheck, lint, boundaries, contract drift, unit and integration tests: what CI runs                                                                                                             |
| `pnpm test` / `pnpm test:e2e` / `pnpm test:screens` | Vitest; Playwright flows against an API it starts on the e2e database with Garmin fixtures; screenshot comparison with the browser in the Playwright Docker image (`--update` rewrites baselines) |
| `pnpm build` / `pnpm contract:build`                | production bundles; zod → JSON Schema into `packages/shared/src/json-schema/`                                                                                                                     |
| `pnpm --filter @running-coach/<pkg> check`          | one package's typecheck, lint and tests                                                                                                                                                           |
| `pnpm seed:owner`                                   | creates the owner from `OWNER_*`, or resets its name and password and signs it out everywhere                                                                                                     |
| `pnpm db:generate` / `pnpm db:migrate`              | SQL from the Drizzle schema; apply locally                                                                                                                                                        |
| `pnpm py:check`                                     | ruff, mypy, pytest for `services/garmin` through uv                                                                                                                                               |
| `pnpm garmin:connect <app-url>`                     | laptop CLI: signs in to the app, logs in to Garmin with 2FA in the terminal, uploads the token bundle, which the API proves with one call and stores encrypted                                    |
| `pnpm coach:dev`                                    | the coach service on 127.0.0.1:8777 for the owner's Claude plan, on this laptop's Claude Code login (needs `COACH_SERVICE_SECRET`)                                                                |
| `pnpm worktree:add <lane>`                          | a sibling worktree `../running-coach-<lane>` at `origin/main` for one parallel session: installs, links `reference`, writes its e2e slot, never copies `.env`                                     |

## Consistency standards

- One contract: zod schemas in `packages/shared`, written once. The API parses with them at every edge; the web client imports their types; the Python service validates the responses it builds from its fixtures against the exported JSON Schema in CI. No duplicate type declarations.
- Naming: files kebab-case; React components PascalCase; tables and columns snake_case; JSON camelCase; Python snake_case.
- Units and time: store meters, seconds, bpm, UTC timestamps plus the activity's own time zone. Convert only at the UI edge with the user's settings.
- Errors: typed domain errors → one Express error middleware → problem+json, including from the Python service. One error code list in `packages/shared`; user-facing messages mapped in one place in the web app and they say what happened and what to do.
- Logs: pino JSON lines with a request id that flows web → API → Garmin service. Never log tokens, keys, passwords or raw health data.
- Data fetching: TanStack Query over one fetch wrapper; keys are `[resource, "list" | "detail", ...ids]`.
- Design: every color, type size, spacing step and radius is a token in `apps/web/src/styles/tokens.css`; lint rejects raw values. One accent; fixed color per workout type; dark only.
- Boundaries (lint-enforced): web never imports api; engine and shared import no I/O; routes never touch the database directly.
- Idempotent external writes: track Garmin workout and schedule ids; jobs have deterministic ids; a double fire is a no-op.

## Quality bar (every slice)

- zod at every edge; React error boundaries; no swallowed errors.
- External calls (Garmin service, Claude): timeouts, retries with backoff and jitter for transient errors only, never on 429 from Garmin, clear failure states in the UI.
- Claude output is structured JSON validated with zod; invalid output falls back to a fixed card. Prompts are versioned files, never inline strings.
- Tests: TDD in `packages/engine`; integration tests against a real Postgres, no DB mocks; Garmin fixtures are sanitized; e2e on setup, sync, plan and run detail; screenshots use fake seeded data only (the repo is public).
- Security: secrets encrypted at rest (AES-256-GCM, key version prefix); CORS locked to the app origin; rate limits on auth; dependency audit in CI.
- Corner cases are part of each slice's acceptance list in its issue: token expiry and 2FA, Garmin outage or 429, duplicate or edited activities, indoor runs, missing HR, GPS glitches, time zones and DST, unit conversion, missed or moved sessions, illness or injury pauses, race date change, regenerating a plan without losing history, invalid Claude key, Claude quota or timeout, partial sync, overlapping syncs, a daily job firing twice.

## Documentation budget

Only these docs exist: CLAUDE.md, SPEC.md (one page), README (setup and run). Files under `.claude/` are configuration: short and concrete. No PRDs, architecture docs, ADRs, progress reports, status files or end-of-task summaries. Progress lives in GitHub issues and PRs; PR descriptions are at most 5 lines. Comments explain why, not what. When in doubt, ship a working slice instead of writing about it.

## Sessions

- One slice per session. Backlog: pinned #46 holds the lanes and their build order, #13 to #19 hold deferred trade-offs, #20 is the owner's setup checklist.
- Model: claude-opus-5-5 at xhigh effort (the highest `effortLevel`) with ultracode on, both set in `.claude/settings.json`; subagents in `.claude/agents/` are opus too.
- State lives in SPEC.md, `.claude/`, GitHub issues and git, never only in chat. Search with the Explore subagent; do not read the whole repo.
- Stop only for: slice plan approval, secrets, paid services, deleting data, anything public beyond this repo. Everything else: decide and continue.
- Context running low mid-slice: commit work in progress, add an issue comment of at most 3 lines (done / next / blockers), stop, and tell the owner the one line to resume with.
- Conventional commits. Never force-push. Never read or write `.env` files (hooks block both); `.env.example` is the list of variables.
- Pushing back is welcome: the owner is a software engineer (Java/Spring, React/TypeScript, Node) and wants the why and the trade-off in a sentence, and risks (API access, ToS, security, privacy, cost) flagged early.

## Parallel sessions

- One lane per sibling worktree, one session per lane, at most three at once; #46 names the lanes. `pnpm worktree:add <lane>` makes the folder; each slice branches there from `origin/main`.
- Main folder only, since they need the owner's `.env` or own shared state: `pnpm dev`, `coach:dev`, `db:migrate`, `seed:owner`, `garmin:connect`, and creating the Postgres container. Every start is `docker compose up -d --wait --no-recreate postgres`: compose's config hash differs per folder, so a plain `up` from a worktree recreates the shared container mid-test.
- Each folder runs the checks, `test:e2e` and `test:screens` on its own e2e slot (ports, database, fake Claude Code nonce; `.claude/rules/tests.md`), one e2e run at a time per folder.
- Migrations: one PR with a migration merges at a time; renumber yours as `.claude/rules/migrations.md` says when `origin/main` gained one.
- `ENGINE_VERSION` and `generatePlan` belong to lane main; other lanes call them and never change them.
- Screenshot baselines are re-recorded per spec and never merged by hand.
- Catch up by merging: `git merge origin/main`, never a rebase. `/ship` merges before its checks and squashes only before the first push.

## Coach

Voice: plain words, short sentences, specific numbers. What happened, what it means, what to do next. No hype, emoji, congratulation openers or filler. Safety: load goes up gradually and missed sessions are never caught up; pain, injury, illness or unusual HR mean rest or easy running and a suggestion to see a professional. Full rules in `.claude/rules/coach-prompts.md`.
