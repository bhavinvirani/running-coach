"""Every response the service builds from the fixtures matches the JSON Schema exported from zod.

The fixtures are raw Garmin shapes, so the contract is checked on what the endpoints return.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from garmin_service.models.problem import ErrorCode
from tests.conftest import AppFactory
from tests.helpers import JSON_SCHEMA_DIR, ScriptedGarmin, bundle

FULL_RANGE = {"startDate": "2026-08-31", "endDate": "2026-09-27"}


def validator(name: str) -> Draft202012Validator:
    schema = json.loads((JSON_SCHEMA_DIR / f"{name}.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def assert_valid(name: str, instance: Any) -> None:
    errors = [
        f"{list(e.absolute_path)}: {e.message}" for e in validator(name).iter_errors(instance)
    ]
    assert errors == [], errors


@pytest.mark.parametrize("behaviour", [None, "rotate", "rotated"])
def test_profile_responses_match_garmin_profile_response(
    client: TestClient, behaviour: str | None
) -> None:
    sent = bundle() if behaviour is None else bundle(fixture=behaviour)
    response = client.post("/profile", json={"tokenBundle": sent})

    assert response.status_code == 200
    assert_valid("garmin-profile-response", response.json())


@pytest.mark.parametrize(
    "date_range", [FULL_RANGE, {"startDate": "2026-08-30", "endDate": "2026-08-30"}]
)
def test_sync_responses_match_garmin_sync_response(
    client: TestClient, date_range: dict[str, str]
) -> None:
    response = client.post("/sync", json={"tokenBundle": bundle(), **date_range})

    assert response.status_code == 200
    assert_valid("garmin-sync-response", response.json())
    for activity in response.json()["activities"]:
        assert_valid("garmin-activity-summary", activity)


def test_sync_requests_the_tests_send_match_garmin_sync_request() -> None:
    assert_valid("garmin-sync-request", {"tokenBundle": bundle(), **FULL_RANGE})
    assert_valid("garmin-profile-request", {"tokenBundle": bundle()})


def error_responses(make_client: AppFactory) -> dict[str, Any]:
    client = make_client()
    crashing = ScriptedGarmin(login_error=RuntimeError("boom")).connect()
    return {
        "unauthorized": make_client(secret_header="wrong").get("/health"),
        "expired": client.post("/profile", json={"tokenBundle": bundle(fixture="expired")}),
        "rate_limited": client.post(
            "/sync", json={"tokenBundle": bundle(fixture="rate_limited"), **FULL_RANGE}
        ),
        "unavailable": client.post("/profile", json={"tokenBundle": bundle(fixture="unavailable")}),
        "validation": client.post("/sync", json={"tokenBundle": bundle()}),
        "not_found": client.get("/nope"),
        "internal": make_client(connect=crashing).post("/profile", json={"tokenBundle": bundle()}),
    }


def test_every_error_response_matches_problem(make_client: AppFactory) -> None:
    responses = error_responses(make_client)

    assert {name: r.status_code for name, r in responses.items()} == {
        "unauthorized": 401,
        "expired": 401,
        "rate_limited": 429,
        "unavailable": 502,
        "validation": 400,
        "not_found": 404,
        "internal": 500,
    }
    for response in responses.values():
        assert response.headers["content-type"] == "application/problem+json"
        assert_valid("problem", response.json())


def test_every_error_code_of_the_service_is_a_shared_code() -> None:
    schema = json.loads((JSON_SCHEMA_DIR / "problem.json").read_text(encoding="utf-8"))
    shared_codes = set(schema["properties"]["code"]["enum"])

    assert {code.value for code in ErrorCode} <= shared_codes
