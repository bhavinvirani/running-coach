---
name: garmin-call
description: Use when adding or changing a call to Garmin through services/garmin and its Node client, including the pydantic model, shared contract, TypeScript client and sanitized fixture.
---

# Garmin call

Library facts (token rotation, method names and arguments, workout model, error chains) are in `garminconnect-api.md` in this folder; a method not listed there is added to that file in the same PR. Copy `services/garmin/garmin_service/routes/profile.py`, `services/garmin/tests/test_profile.py`, `services/garmin/tests/fixtures/profile.json`, `services/garmin/garmin_service/fake_client.py` and `apps/api/src/garmin/client.ts`.

1. Contract: request and response schemas in `packages/shared/src/contracts/garmin.ts`; `pnpm contract:build` exports the JSON Schema that `services/garmin/tests/test_contract.py` validates every response against. Errors use `garminProblemSchema`.
2. Python route in `services/garmin/garmin_service/routes/<name>.py`: takes `tokenBundle`, `garmin = connect(body.token_bundle)` (a `GarminSession` logged in with `login(tokenstore=bundle)`), every library call through `garmin.call(fn, ...)`, which keeps `GARMIN_CALL_GAP_S` between calls; returns the data plus `garmin.token_bundle()`. Nothing is caught in the route: `garmin_service/errors.py` maps exceptions by their cause chain and adds the bundle when login rotated it. Add the method to the `GarminApi` protocol in `garmin_service/client.py`. Pydantic models on `RequestModel` and `ResponseModel` from `models/base.py`.
3. Fixture: capture one real response through `services/garmin/tests/sanitize.py` (ids renumbered; names, free text, emails and URLs replaced; locations, coordinates, polylines and profile images removed), read it, commit the sanitized JSON, and add the case to `FakeGarmin` in `garmin_service/fake_client.py`.
4. Node client: one typed method in `apps/api/src/garmin/client.ts` through its `post(path, requestSchema, request, responseSchema, timeoutMs)`: timeout, the retry policy of `fetchJson` (never on 4xx or a timeout), `x-garmin-secret` and `x-request-id`. The calling service wraps it in `withUserLock` and writes back a changed bundle, also the one a Garmin-service error carries.
5. Tests: pytest for the route (success, rotated bundle, bad secret, 429, expired token, Garmin down) and the contract test; an API test in `apps/api/test/garmin/client.test.ts` against the fixture service.
