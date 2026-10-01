# Later: deferred trade-offs

Alternatives considered on 2026-10-01 and set aside. One line each: what, when to revisit. Phase 3 turns every line into a GitHub issue labeled `later` and deletes this file.

## Hosting and infrastructure

- Custom domain (about $10/yr): unlocks cookie-based login across hosts, Google or magic-link login with brand verification, Cloudflare or GitHub Pages for the SPA. Revisit when a second user arrives.
- Google Cloud Run: cold starts in seconds, 60-min requests, Jobs up to 7 days; needs a card and budget alerts. Revisit if Render's 60 s wake becomes painful.
- Home-hosted Garmin service (Raspberry Pi or always-on Mac behind a free Cloudflare Tunnel): residential IP avoids Garmin datacenter blocks and cold starts. Revisit if phase 2 shows Render logins blocked.
- Strava as the read path (official API, free) with Garmin only for workout pushes. Revisit if Garmin reads become unreliable; check Strava's API terms on AI use first.
- PR preview deploys (Render previews, or Neon branch per PR with cleanup). Revisit with a second contributor.
- Build the production image in GitHub Actions and deploy it to Render as a registry image. Revisit if the 500 Hobby build minutes run out.
- Second free Render service for the Python process. Revisit if 512 MB cannot hold Node and uvicorn together.
- Cron keepalive step. Revisit if the GitHub schedule is ever auto-disabled.

## Login

- Google sign-in via Better Auth social: Cloud project, two secrets, Testing-mode user list, iOS installed-PWA popup plus BroadcastChannel or one-time-code fallback. Revisit when other users join.
- Passkeys (@better-auth/passkey): native in the iOS PWA, needs recovery codes; RP ID changes if a domain is added. Revisit as a second login method.
- Magic link or OTP by email via Resend (3,000/month free) and email-based password reset. Revisit when a sender domain exists.
- Database-stored rate limiting. Revisit when there is more than one container.

## Garmin

- Web 2FA connect flow and reconnect UX (V1 scope, deferred past slice 1): two calls holding a live session in process memory.
- Workout pushes routed through the job queue. Revisit if spike 3 shows refresh tokens rotate.
- Per-user cached Garmin client. Revisit only if coarse-grained service calls are not enough.
- OpenAPI to TypeScript codegen with a CI drift check for the Python service. Revisit if the zod-only contract drifts in practice.
- Garmin Connect Developer Program. Business use only; revisit only if this becomes a business.

## Data, jobs, security

- Separate worker process or entrypoint. Revisit on a paid tier or at real scale.
- HKDF per-purpose subkeys, column-bound AAD, a Secret wrapper type. Revisit if secrets multiply or a security review asks.
- Key rotation job (re-encrypt on read). Build when a second key is added.
- Kysely instead of Drizzle. Revisit if drizzle-kit diffs misbehave on expand/contract migrations; Drizzle 1.0 is its own upgrade slice.
- graphile-worker instead of pg-boss. Revisit if pg-boss maintenance stalls.

## Frontend

- TanStack Router instead of React Router. Revisit if URL-held typed search params (run filters, chart ranges) become central.
- visx or uPlot instead of Recharts, plus a size-limit bundle budget. Revisit if phone rendering stutters or the chart chunk grows past about 200 KB gzipped.
- MapLibre instead of Mapbox GL. Revisit if Mapbox terms or the 50k free loads per month bite.
- Spacing step allowlist regex for Tailwind. Revisit if the first standards audit finds off-scale spacing.
- Biome instead of ESLint plus Prettier. Revisit when its Tailwind rules leave nursery.
- dependency-cruiser for cycle detection. Revisit if cycles appear.

## Claude coach

- Per-user model picker populated from GET /v1/models. Revisit when users ask.
- Sonnet for insight cards and Opus for reviews and plans (about $0.63 per user per month). Revisit if Opus insight latency exceeds about 5 s or an eval shows parity.
- Fable 5.1 as the coach model (about $2.21 per user per month). Revisit if coaching quality falls short.
- Prompt caching. Revisit if calls cluster within 5 minutes, for example a separate adjustment call after each insight.
- Batch API for weekly reviews and plan generation (50% off). Revisit if cost matters.
- Monthly token usage shown in Settings.

## Engine and product

- ACWR as a gate instead of display-only. Revisit if a prospective runner validation is published.
- Marathon prediction margin calibrated from the user's own history.
- Multi-user: sign-up on, email verification, per-user Mapbox token restriction, data export and account deletion.
