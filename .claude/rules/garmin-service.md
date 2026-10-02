---
paths:
  - "services/garmin/**"
---
# Garmin service (services/garmin)

- FastAPI on uvicorn bound to 127.0.0.1, started by the API as a child process. Every request carries `x-garmin-secret`; a mismatch is 401 before any other work. Never reachable from the public port.
- Stateless: each request body carries `tokenBundle` (the decrypted JSON string) and every response returns `tokenBundle`, refreshed or unchanged. No file tokenstore, no module-level client, no cache across requests. The connect endpoint is the only place a password is accepted; it returns `needsMfa` or a bundle and stores nothing.
- Coarse endpoints, one per use case (`POST /profile`, `POST /sync`, `POST /activities/{id}/detail`, `POST /workouts`, `POST /schedule`, `POST /connect`), not one per library method. At least 1 s between underlying library calls inside an endpoint, from one constant `GARMIN_CALL_GAP_S = 1.0`. A 429 from Garmin is returned as 429 with `retryAfterSeconds` and never retried here.
- Errors: problem+json with the shared codes (`garmin_auth_expired`, `garmin_rate_limited`, `garmin_unavailable`, `garmin_mfa_required`). Library exceptions are mapped in one place, `services/garmin/garmin_service/errors.py`.
- Models: pydantic v2 in `garmin_service/models/`, snake_case fields with camelCase aliases on the wire. The zod schema in `packages/shared` is the contract; CI validates `tests/fixtures/*.json` against the exported JSON Schema.
- Library facts (token rotation, method names and arguments, workout model) live in `.claude/skills/garmin-call/garminconnect-api.md`. A method not listed there gets added to that file in the same PR, with what was verified.
- Tests: pytest with the `Garmin` client replaced by a fake serving `tests/fixtures/*.json`. Fixtures are produced by `tests/sanitize.py` (ids renumbered, names, locations and coordinates replaced); a raw Garmin response is never committed. `GARMIN_FIXTURES=1` makes the service serve the same files for CI e2e.
- Tooling: uv, ruff format and lint, mypy strict, Python 3.12. `garminconnect` pinned exactly and excluded from Dependabot auto-merge.
- Logs: JSON lines with the `request_id` from `x-request-id`; never the bundle, email, password, MFA code or activity payloads.

Reference (phase 5): `services/garmin/garmin_service/routes/profile.py`, `services/garmin/tests/test_profile.py`, `services/garmin/tests/fixtures/profile.json`.
