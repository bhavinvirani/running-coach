"""Every response the service builds from the fixtures matches the JSON Schema exported from zod.

The fixtures are raw Garmin shapes, so the contract is checked on what the endpoints return.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from garmin_service.models.problem import ErrorCode
from tests.conftest import AppFactory
from tests.helpers import JSON_SCHEMA_DIR, ScriptedGarmin, assert_valid, bundle, raw_run

FULL_RANGE = {"startDate": "2026-08-31", "endDate": "2026-09-27"}


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


@pytest.mark.parametrize(
    "event_type",
    [{"typeId": 1, "typeKey": "race", "sortOrder": 10}, None, "absent", {"typeKey": ""}],
)
def test_sync_responses_with_any_event_type_match_garmin_sync_response(
    make_client: AppFactory, event_type: object
) -> None:
    item = raw_run(eventType=event_type)
    if event_type == "absent":
        del item["eventType"]
    garmin = ScriptedGarmin(activities=[item])

    response = make_client(connect=garmin.connect()).post(
        "/sync", json={"tokenBundle": bundle(), **FULL_RANGE}
    )

    assert response.status_code == 200
    assert_valid("garmin-sync-response", response.json())
    assert_valid("garmin-activity-summary", response.json()["activities"][0])


@pytest.mark.parametrize(
    "page",
    [
        {"start": 0, "limit": 10},
        {"start": 40, "limit": 10},
        {"start": 49, "limit": 10},
        {"start": 0, "limit": 200},
        {"start": 0, "limit": 1, "tokenBundle": bundle(fixture="rotate")},
    ],
)
def test_history_responses_match_garmin_history_response(
    client: TestClient, page: dict[str, Any]
) -> None:
    request = {"tokenBundle": bundle(), **page}
    assert_valid("garmin-history-request", request)

    response = client.post("/history", json=request)

    assert response.status_code == 200
    assert_valid("garmin-history-response", response.json())
    for activity in response.json()["activities"]:
        assert_valid("garmin-activity-summary", activity)


@pytest.mark.parametrize(
    ("activity_id", "behaviour"),
    [
        (10_000_000_007, None),  # outdoor, with the fake's fictional route
        (10_000_000_006, None),  # treadmill
        (10_000_000_004, None),  # no heart rate
        (10_000_000_003, None),  # manual entry
        (9_000_000_035, None),  # heart rate 0
        (10_000_000_007, "rotate"),
    ],
)
def test_activity_detail_responses_match_garmin_activity_detail_response(
    client: TestClient, activity_id: int, behaviour: str | None
) -> None:
    request = {"tokenBundle": bundle() if behaviour is None else bundle(fixture=behaviour)}
    assert_valid("garmin-activity-detail-request", request)

    response = client.post(f"/activities/{activity_id}/detail", json=request)

    assert response.status_code == 200
    assert_valid("garmin-activity-detail-response", response.json())
    assert_valid("activity-detail", response.json()["detail"])


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
        "rotate_then_rate_limited": client.post(
            "/sync", json={"tokenBundle": bundle(fixture="rotate_then_rate_limited"), **FULL_RANGE}
        ),
        "rotate_then_unavailable": client.post(
            "/sync", json={"tokenBundle": bundle(fixture="rotate_then_unavailable"), **FULL_RANGE}
        ),
        "validation": client.post("/sync", json={"tokenBundle": bundle()}),
        "history_rotate_then_rate_limited": client.post(
            "/history",
            json={
                "tokenBundle": bundle(fixture="rotate_then_rate_limited"),
                "start": 0,
                "limit": 10,
            },
        ),
        "history_validation": client.post(
            "/history", json={"tokenBundle": bundle(), "start": 0, "limit": 201}
        ),
        "detail_not_found": client.post("/activities/12345/detail", json={"tokenBundle": bundle()}),
        "detail_rotate_then_unavailable": client.post(
            "/activities/10000000007/detail",
            json={"tokenBundle": bundle(fixture="rotate_then_unavailable")},
        ),
        "not_found": client.get("/nope"),
        "internal": make_client(connect=crashing).post("/profile", json={"tokenBundle": bundle()}),
    }


def test_every_error_response_matches_garmin_problem(make_client: AppFactory) -> None:
    responses = error_responses(make_client)

    assert {name: r.status_code for name, r in responses.items()} == {
        "unauthorized": 401,
        "expired": 401,
        "rate_limited": 429,
        "unavailable": 502,
        "rotate_then_rate_limited": 429,
        "rotate_then_unavailable": 502,
        "validation": 400,
        "history_rotate_then_rate_limited": 429,
        "history_validation": 400,
        "detail_not_found": 404,
        "detail_rotate_then_unavailable": 502,
        "not_found": 404,
        "internal": 500,
    }
    for response in responses.values():
        assert response.headers["content-type"] == "application/problem+json"
        assert_valid("garmin-problem", response.json())
    carrying_a_bundle = {name for name, r in responses.items() if "tokenBundle" in r.json()}
    assert carrying_a_bundle == {
        "rotate_then_rate_limited",
        "rotate_then_unavailable",
        "history_rotate_then_rate_limited",
        "detail_rotate_then_unavailable",
    }


def test_every_error_code_of_the_service_is_a_shared_code() -> None:
    schema = json.loads((JSON_SCHEMA_DIR / "garmin-problem.json").read_text(encoding="utf-8"))
    shared_codes = set(schema["properties"]["code"]["enum"])

    assert {code.value for code in ErrorCode} <= shared_codes
