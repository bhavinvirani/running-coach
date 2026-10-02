"""POST /profile through the real app, with the fixture fake or a scripted Garmin behind it."""

from __future__ import annotations

import json

from garminconnect import GarminConnectAuthenticationError, GarminConnectConnectionError

from tests.conftest import AppFactory
from tests.helpers import BASE_BUNDLE, ScriptedGarmin, bundle

PROBLEM_JSON = "application/problem+json"


def test_returns_the_runners_name_and_the_unchanged_bundle(make_client: AppFactory) -> None:
    sent = bundle()
    response = make_client().post("/profile", json={"tokenBundle": sent})

    assert response.status_code == 200
    assert response.json() == {"tokenBundle": sent, "profile": {"displayName": "Alex Fixture"}}


def test_returns_the_rotated_bundle_when_login_refreshed_the_tokens(
    make_client: AppFactory,
) -> None:
    response = make_client().post("/profile", json={"tokenBundle": bundle(fixture="rotate")})

    assert response.status_code == 200
    returned = json.loads(response.json()["tokenBundle"])
    assert returned == {**BASE_BUNDLE, "fixture": "rotated"}


def test_returns_401_unauthorized_and_never_logs_in_when_the_secret_is_wrong(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()
    for secret in (None, "wrong-secret"):
        client = make_client(secret_header=secret, connect=garmin.connect())
        response = client.post("/profile", json={"tokenBundle": bundle()})

        assert response.status_code == 401
        assert response.headers["content-type"] == PROBLEM_JSON
        assert response.json()["code"] == "unauthorized"
    assert garmin.calls == []


def test_returns_401_garmin_auth_expired_when_the_bundle_is_expired(
    make_client: AppFactory,
) -> None:
    response = make_client().post("/profile", json={"tokenBundle": bundle(fixture="expired")})

    assert response.status_code == 401
    assert response.headers["content-type"] == PROBLEM_JSON
    assert response.json()["code"] == "garmin_auth_expired"
    assert "tokenBundle" not in response.text


def test_returns_429_with_retry_after_when_garmin_rate_limits(make_client: AppFactory) -> None:
    response = make_client().post("/profile", json={"tokenBundle": bundle(fixture="rate_limited")})

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    body = response.json()
    assert body["code"] == "garmin_rate_limited"
    assert body["retryAfterSeconds"] == 3600


def test_returns_502_garmin_unavailable_when_garmin_is_down(make_client: AppFactory) -> None:
    response = make_client().post("/profile", json={"tokenBundle": bundle(fixture="unavailable")})

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


def test_returns_502_not_expired_when_the_profile_load_hits_a_network_error(
    make_client: AppFactory,
) -> None:
    # login() wraps any profile-load failure in an auth error; the network cause must win.
    error = GarminConnectAuthenticationError("Failed to retrieve social profile")
    error.__cause__ = ConnectionError("connection reset")
    garmin = ScriptedGarmin(login_error=error)

    response = make_client(connect=garmin.connect()).post(
        "/profile", json={"tokenBundle": bundle()}
    )

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


def test_returns_401_expired_without_calling_garmin_when_the_bundle_is_not_json(
    make_client: AppFactory,
) -> None:
    # garminconnect would read a non-JSON tokenstore as a file path.
    garmin = ScriptedGarmin()
    client = make_client(connect=garmin.connect())

    response = client.post("/profile", json={"tokenBundle": "~/.garminconnect"})

    assert response.status_code == 401
    assert response.json()["code"] == "garmin_auth_expired"
    assert garmin.calls == []


def test_returns_400_validation_without_echoing_the_body(make_client: AppFactory) -> None:
    client = make_client()
    for body in (
        {},
        {"token_bundle": bundle()},
        {"tokenBundle": bundle(), "extra": 1},
        {"tokenBundle": 42},
    ):
        response = client.post("/profile", json=body)

        assert response.status_code == 400, body
        problem = response.json()
        assert problem["code"] == "validation"
        assert problem["issues"]
        assert "fixture-token" not in response.text


def test_falls_back_to_the_garmin_display_name_when_there_is_no_full_name(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(full_name="  ", display_name="runner-handle")

    response = make_client(connect=garmin.connect()).post(
        "/profile", json={"tokenBundle": bundle()}
    )

    assert response.json()["profile"] == {"displayName": "runner-handle"}


def test_maps_a_library_connection_error_with_403_to_unavailable(make_client: AppFactory) -> None:
    # A 403 is a Cloudflare or IP block in practice; calling it expired would force a new login.
    error = GarminConnectAuthenticationError("Failed to retrieve social profile")
    error.__cause__ = GarminConnectConnectionError("API Error 403")
    garmin = ScriptedGarmin(login_error=error)

    response = make_client(connect=garmin.connect()).post(
        "/profile", json={"tokenBundle": bundle()}
    )

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"
