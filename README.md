# Running Coach

A mobile-first PWA that syncs Garmin runs, builds a training plan and reviews each run with Claude. Decisions live in [SPEC.md](SPEC.md).

## Prerequisites

Node 24, pnpm 10 (`corepack enable`), Docker, [uv](https://docs.astral.sh/uv/).

## Setup

```sh
cp .env.example .env              # then set MASTER_KEY; the other local values work as they are
pnpm install
(cd services/garmin && uv sync)   # the API spawns the Garmin service from this venv
pnpm --filter @running-coach/web exec playwright install chromium   # once, for pnpm test:e2e
```

Set `MASTER_KEY` before the first run (`openssl rand -base64 32`): it encrypts Garmin tokens and Claude keys, and the API will not start without it.

## Run

```sh
pnpm dev          # Postgres (docker compose, port 5434), API + worker + Garmin service, web at http://localhost:5173
pnpm seed:owner   # once, after setting OWNER_EMAIL, OWNER_PASSWORD and OWNER_NAME in .env; needs the database up
```

Garmin: `pnpm garmin:connect http://localhost:5173` (or the Render URL) signs in to the app as you, asks for your Garmin email, password and 2FA code, and uploads the token bundle, which the API checks with one Garmin call and stores encrypted; nothing is written to disk. Then tap Sync now on Today.

Coach on your Claude plan (owner only, optional): set `COACH_SERVICE_URL=http://127.0.0.1:8777` and a `COACH_SERVICE_SECRET` (`openssl rand -hex 32`) in `.env`, run `pnpm coach:dev` beside `pnpm dev`, and choose Claude plan in Settings. Locally the coach service uses this machine's Claude Code login; `pnpm --filter @running-coach/api coach:eval --plan` runs the prompt eval through it.

Database: `pnpm db:generate` writes a SQL migration from the Drizzle schema, `pnpm db:migrate` applies it locally (the API also migrates at start).

## Test

```sh
pnpm check                  # typecheck, lint, boundaries, contract drift, unit and integration tests, engine coverage (what CI runs)
pnpm test                   # Vitest only
pnpm test:e2e               # Playwright flows; starts its own API on port 4173 with the e2e database
pnpm test:screens           # screenshots, browser in the Playwright Docker image (needs Docker; first pull about 2 GB); --update rewrites the baselines
pnpm py:check               # ruff, mypy and pytest for services/garmin
pnpm build                  # production bundles
pnpm contract:build         # zod contracts to JSON Schema in packages/shared/src/json-schema/
```

## Deploy

Render Blueprint: in the Render dashboard choose New, Blueprint, and pick this repo. It reads `render.yaml` (two free Docker web services: the app and the coach service) and asks once for each secret; `.env.example` lists them with their formats. `DATABASE_URL` is Neon's direct (non-pooler) connection string with `sslmode=require` changed to `sslmode=verify-full`, and `APP_URL` is the service's `onrender.com` URL. The daily sync (`.github/workflows/daily-sync.yml`) needs two GitHub repository secrets: `APP_URL`, the same URL, and `CRON_SECRET`, the value Render holds.

The first boot creates the owner from `OWNER_EMAIL`, `OWNER_PASSWORD` and `OWNER_NAME`; later boots never change it. To change the owner password, run `pnpm seed:owner` from an up-to-date `main` with `DATABASE_URL` set to Neon's URL and the new `OWNER_*` values; it also signs out every session.

The coach on the owner's Claude plan is the second service in `render.yaml`. Before turning it on, turn off "Help improve Claude" in claude.ai's privacy settings (the prompts carry heart rate). Run `claude setup-token` on your laptop and paste the token into the coach service's `CLAUDE_CODE_OAUTH_TOKEN` when Render asks; the service will not start without it. Then set the main service's `COACH_SERVICE_URL` to the coach service's `onrender.com` URL and choose Claude plan in Settings; Render generates and shares `COACH_SERVICE_SECRET`. The token lasts a year: when it expires the run card says so, and a new `claude setup-token` replaces it.

After that, every push to `main` deploys once CI passes, and migrations run at start. To roll back, open the service's Deploys page and choose Rollback on an earlier deploy. A dashboard rollback turns auto-deploy off, so turn it back on in Settings once the fix is on `main`.
