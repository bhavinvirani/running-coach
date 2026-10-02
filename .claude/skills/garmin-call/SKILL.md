---
name: garmin-call
description: Use when adding or changing a call to Garmin through services/garmin and its Node client, including the pydantic model, shared contract, TypeScript client and sanitized fixture.
---
# Garmin call

Library facts verified in the phase 2 spikes (token rotation, method names and arguments, workout model) are in `garminconnect-api.md` in this folder; a method not listed there is added to that file in the same PR. Copy `services/garmin/garmin_service/routes/profile.py`, `services/garmin/tests/test_profile.py`, `services/garmin/tests/fixtures/profile.json` and `apps/api/src/garmin/client.ts`.

1. Contract: request and response schemas in `packages/shared/src/contracts/garmin.ts`; `pnpm contract:build` exports the JSON Schema the Python tests validate against.
2. Python route in `services/garmin/garmin_service/routes/<name>.py`: takes `tokenBundle`, builds the client with `Garmin().login(tokenstore=bundle)`, sleeps `GARMIN_CALL_GAP_S` between library calls, returns the data plus `client.dumps()` as the new bundle. Exceptions are mapped in `services/garmin/garmin_service/errors.py`. Pydantic models with camelCase aliases.
3. Fixture: capture one real response through `services/garmin/tests/sanitize.py` (ids renumbered; names, locations and coordinates replaced), commit the sanitized JSON, add the fake-client case.
4. Node client: one typed method in `apps/api/src/garmin/client.ts` with a timeout, the retry policy (never on 429), `x-garmin-secret` and `x-request-id`. The caller wraps it in `withUserLock` and writes back a changed bundle.
5. Tests: pytest for the route (success, bad secret, 429, expired token); an API integration test with `GARMIN_FIXTURES=1`.
