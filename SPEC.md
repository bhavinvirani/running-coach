# Running Coach: spec

## Goal and scope

A mobile-first PWA that replaces a Runna subscription for one runner first, more later. It syncs Garmin runs, builds a training plan for any goal (5K to marathon, with or without a race date), puts structured workouts on the watch, reviews each run against the plan with Claude as the coach, and adapts the plan. Each user brings their own Garmin account and Claude API key; the app costs $0 to run.

## Architecture

1. `apps/web`: Vite + React PWA, served by the API from the same origin; TanStack Query over a typed fetch wrapper; Recharts; Mapbox map.
2. `apps/api`: Express + TypeScript. Routes validate with zod, call services, persist with Drizzle on Postgres (Neon). Better Auth sessions. pg-boss worker runs in the same process.
3. `services/garmin`: FastAPI wrapping `garminconnect`, spawned by the API on 127.0.0.1 and called with a shared-secret header. Stateless: token bundle in, refreshed bundle out, coarse operations (sync since date, push workout). Every Garmin call for a user runs under one per-user lock in the API.
4. `packages/engine`: pure TypeScript training rules, no I/O, test-first. `packages/shared`: zod contracts, error codes, units.
5. Claude: the API calls the Claude API with the user's key, versioned prompt files, structured JSON output validated with zod, fallback card when invalid.
6. Scheduler: a GitHub Actions cron calls a secret-protected endpoint daily; sync also runs on app open and on a Sync button. Jobs have deterministic ids so double fires are no-ops.
7. One Docker image on a Render free web service; migrations run at process start; `/health`; request id flows web to API to Garmin service; problem+json errors everywhere.

## Core tables

- `user`, `session`, `account` (Better Auth); `user_settings` (user_id, units, timezone, hr_zones, coach_detail, claude_key_enc).
- `garmin_connection` (user_id, token_bundle_enc, status ok|expired, last_sync_at, last_error).
- `activity` (garmin_activity_id, user_id, type, start_utc, start_local, tz, distance_m, duration_s, avg_hr, max_hr, cadence, calories, elevation_gain_m, is_indoor, is_manual, garmin_updated_at, summary jsonb); `activity_lap` (activity_id, idx, distance_m, duration_s, avg_hr, avg_cadence); `activity_stream` (activity_id, elapsed_s[], distance_m[], hr[], cadence[], elevation_m[], speed_mps[], route jsonb, hr_zones jsonb: Garmin's thinned series, track and seconds in zone, fetched once on first open).
- `personal_best` (user_id, distance_key, activity_id, time_s, achieved_at).
- `goal` (user_id, kind race|fitness, distance_key, race_date, target_time_s, days_per_week, long_run_day); `plan` (goal_id, version, engine_version, status); `plan_session` (plan_id, date, type, target jsonb, steps jsonb, status planned|done|missed|moved, activity_id, garmin_workout_id, garmin_schedule_id).
- `coach_message` (user_id, kind insight|weekly_review|race_plan, activity_id, plan_id, prompt_version, model, content jsonb, feedback, usage jsonb); `import_progress` (user_id, status running|paused|failed|done, next_offset, cursor_date, last_error, resume_at, started_at, finished_at).

## Plan engine: rules vs Claude

- The engine owns every number as pure tested functions; Claude picks among engine-validated session templates, writes the text, and proposes deltas the engine accepts or clamps. Only the engine writes plan state.
- Rules (constants in one cited file): paces from Daniels VDOT of the best recent race; weekly volume up at most 10% and no run over 110% of the 30-day longest; down week every 4th; at least 80% easy time; at most 2 quality sessions at 3 runs a week; 48 h between hard days; long run at most 30% of weekly volume or 150 min; T at most 10%, I 8%, R 5% of weekly km per session; taper 2 weeks (3 for marathon) cutting volume 40 to 60%; minimum plan 8 weeks 5K/10K, 12 half, 18 marathon.
- Missed runs are dropped, never rescheduled. Re-entry at 70% volume after 7 days off, 50% after 14; walk-run return after injury or illness. When a goal exceeds the caps at the user's days per week, the engine reports the conflict instead of bending.
- Riegel 1.06 for predictions with a marathon margin; ACWR display-only.

## Decisions

- **Hosting:** one Render free web service (0.1 CPU, 512 MB) with SPA, API, Garmin service and worker in one process; Neon Free Postgres; no card anywhere. Why: the only $0 layout without separate workers; one origin keeps cookies simple.
- **Rejected hosts:** GitHub Pages, Cloudflare, Vercel (split origin breaks Safari cookies), Cloud Run (billing), Fly, Koyeb, Railway (card), Render Postgres (expires), Oracle (reclaims VMs).
- **Cold start:** 60 s wake after 15 min idle, hidden by a service-worker-cached shell and a "waking" state.
- **No previews:** CI runs e2e and screenshots against an API started on a Postgres service with Garmin fixtures; Render builds main only. Previews return with a second contributor.
- **Deploy:** migrations at process start, expand/contract only; rollback is Render's redeploy of the previous build. Daily cron via GitHub Actions; Dependabot activity keeps it enabled; Settings shows last sync.
- **Login:** email + password via Better Auth, sign-up off, in-memory rate limits, owner seeded by CLI; Google or passkeys when other users join. Why: no third party, no redirect, works in the installed PWA; email needs a domain we lack.
- **Garmin:** `garminconnect` 0.3.x native auth (garth deprecated), pinned. Token bundle encrypted per user; access token about 24.6 h; refresh token rotates, so write back after every call and serialize per user. About 1 s between calls, never auto-retry 429. Slice 1 connects via a laptop CLI; the web 2FA flow (in-memory state, two calls) comes later. Details in `.claude/skills/garmin-call/garminconnect-api.md`.
- **Garmin risk:** accepted for personal use. Unofficial client, fingerprint and datacenter blocks seen; Render's IP passed in slice 1; fallbacks in the `later` issues (#13 to #19).
- **Garmin calendar:** the app touches only workouts it created (IDs tracked) and offers to unschedule third-party ones in the plan window.
- **Watch:** Instinct 2 Solar, firmware 13.19+: pace/HR/time/distance step workouts and strength sets; HRV, training readiness, status and load, VO2 max, running power; no running dynamics or multi-band GPS.
- **Contract:** zod only, written once in `packages/shared`; Node parses at runtime, Python validates fixtures against the exported JSON Schema. No OpenAPI codegen.
- **Claude:** claude-opus-5-5 at low effort with structured outputs; claude-sonnet-5-5 as env fallback; no caching or Batch; key validated via GET /v1/models; max_tokens 4k insights, 16k plans; check stop_reason before parsing; log usage. About $0.89 per user per month, paid by the user.
- **Data:** Drizzle 0.45.x with committed SQL migrations; pg-boss 12 (stately per-user sync: at most one queued and one running, deterministic job ids, chunked newest-first import); AES-256-GCM with one env key, user id as AAD, key-version prefix; pino redaction.
- **Frontend:** Vite 8, React 19, React Router 8 data mode, vite-plugin-pwa; TanStack Query 5 with `[resource, "list"|"detail", ...]` keys; Recharts 3 via shadcn, 600-point downsampling, animations off, lazy chart screens; react-map-gl 8 + mapbox-gl 3, MapLibre as exit.
- **Tokens and lint:** shadcn CLI 4 on Tailwind 4.3 with the default palette, text scale and radii removed so only token utilities exist; eslint-plugin-better-tailwindcss bans unknown classes and arbitrary values. Details in `.claude/skills/ui-component/tailwind-tokens.md`.
- **Tooling:** ESLint 10 flat config, typescript-eslint, Prettier; eslint-plugin-boundaries (web never imports api; engine and shared import no I/O); eslint-plugin-check-file kebab-case; lefthook pre-commit; Node 24 LTS, pnpm 10, Python 3.12 with uv, ruff, mypy, pytest. Exact pins; Dependabot auto-merges patch and minor except garminconnect.
- **CI:** typecheck, lint, unit and integration on a Postgres service container, Playwright e2e and screenshots in the official container with seeded fake data at an iPhone viewport, Python checks when its files change, build; auto-merge when green.
- **History:** full Garmin history, newest first, one job per page of 100 by offset in Garmin's running list (one call per page, an exact end); each page re-reads 5 list items and commits its cursor. **License:** MIT. **Domain:** host subdomain only.

## Out of scope for v1

Coach chat; sign-up for other users; Google or passkey login; custom domain; preview deploys; Strava; non-running sports; push notifications; native apps; offline editing.

## Open risks

- Garmin may start blocking Render's datacenter IPs; slice 1 synced from Render (2026-10-02). Fallbacks in issue #13.
- 512 MB must hold Node, uvicorn and curl_cffi. Slice 1 measures; fallback is a second free service.
- Whether bot commits count as repository activity for the 60-day cron rule is undocumented; add a keepalive if it ever stops.
