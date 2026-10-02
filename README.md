# Running Coach

A mobile-first PWA that syncs Garmin runs, builds a training plan and reviews each run with Claude. Decisions live in [SPEC.md](SPEC.md).

## Prerequisites

Node 24, pnpm 10 (`corepack enable`), Docker, [uv](https://docs.astral.sh/uv/).

## Setup

```sh
cp .env.example .env              # the local values work as they are
pnpm install
(cd services/garmin && uv sync)   # the API spawns the Garmin service from this venv
pnpm --filter @running-coach/web exec playwright install chromium   # once, for pnpm test:e2e
```

## Run

```sh
pnpm dev          # Postgres (docker compose, port 5434), API + worker + Garmin service, web at http://localhost:5173
pnpm seed:owner   # once, after setting OWNER_EMAIL, OWNER_PASSWORD and OWNER_NAME in .env; needs the database up
```

Database: `pnpm db:generate` writes a SQL migration from the Drizzle schema, `pnpm db:migrate` applies it locally (the API also migrates at start).

## Test

```sh
pnpm check                  # typecheck, lint, boundaries, contract drift, unit and integration tests (what CI runs)
pnpm test                   # Vitest only
pnpm test:e2e               # Playwright flows; starts its own API on port 4173 with the e2e database
pnpm test:screens           # screenshots, browser in the Playwright Docker image (needs Docker; first pull about 2 GB); --update rewrites the baselines
pnpm py:check               # ruff, mypy and pytest for services/garmin
pnpm build                  # production bundles
pnpm contract:build         # zod contracts to JSON Schema in packages/shared/src/json-schema/
```

## Deploy

Render Blueprint: in the Render dashboard choose New, Blueprint, and pick this repo. It reads `render.yaml` (one free Docker web service) and asks once for each secret; `.env.example` lists them with their formats. `DATABASE_URL` is Neon's direct (non-pooler) connection string and `APP_URL` is the service's `onrender.com` URL.

After that, every push to `main` deploys once CI passes, and migrations run at start. To roll back, open the service's Deploys page and choose Rollback on an earlier deploy. A dashboard rollback turns auto-deploy off, so turn it back on in Settings once the fix is on `main`.
