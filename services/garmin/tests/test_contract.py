"""Every response the service builds from the fixtures matches the JSON Schema exported from zod.

The fixtures are raw Garmin shapes, so the contract is checked on what the endpoints return.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from garmin_service.fake_client import FAKE_UNAVAILABLE_ACTIVITY_ID, FAKE_UNAVAILABLE_ACTIVITY_IDS
from garmin_service.models.problem import ErrorCode
from tests.conftest import AppFactory
from tests.helpers import JSON_SCHEMA_DIR, ScriptedGarmin, assert_valid, bundle, raw_run

FULL_RANGE = {"startDate": "2026-08-31", "endDate": "2026-09-27"}
# Both of the fake's unavailable runs, in a row: the series route stops after them.
UNAVAILABLE_IN_A_ROW = sorted(FAKE_UNAVAILABLE_ACTIVITY_IDS)


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


@pytest.mark.parametrize(
    ("ids", "include_records", "behaviour"),
    [
        ([10_000_000_007, 10_000_000_004, 9_000_000_023], True, None),
        ([10_000_000_007], False, None),
        ([10_000_000_003, 12_345], True, None),  # a manual entry and a run Garmin does not have
        # ok, gone, failed and ok without samples in one batch.
        ([10_000_000_007, 12_345, FAKE_UNAVAILABLE_ACTIVITY_ID, 10_000_000_003], True, None),
        ([FAKE_UNAVAILABLE_ACTIVITY_ID], False, None),
        # Two failures in a row: the runs after them are skipped, the records null.
        ([*UNAVAILABLE_IN_A_ROW, 10_000_000_007, 10_000_000_003], True, None),
        ([], True, None),
        ([], False, None),
        ([10_000_000_006, 10_000_000_007], True, "rotate"),
        # The run fails and the records come back null, with the rotated bundle.
        ([10_000_000_007], False, "rotate_then_unavailable"),
        ([], True, "rotate_then_unavailable"),
    ],
)
def test_series_responses_match_garmin_series_response(
    client: TestClient, ids: list[int], include_records: bool, behaviour: str | None
) -> None:
    request = {
        "tokenBundle": bundle() if behaviour is None else bundle(fixture=behaviour),
        "garminActivityIds": ids,
        "includeRecords": include_records,
    }
    assert_valid("garmin-series-request", request)

    response = client.post("/activities/series", json=request)

    assert response.status_code == 200
    assert_series_response_valid(response.json())


def test_series_responses_carry_every_outcome_the_contract_names(client: TestClient) -> None:
    response = client.post(
        "/activities/series",
        json={
            "tokenBundle": bundle(),
            "garminActivityIds": [10_000_000_007, 12_345, *UNAVAILABLE_IN_A_ROW, 10_000_000_002],
            "includeRecords": False,
        },
    )

    assert response.status_code == 200
    assert_series_response_valid(response.json())
    schema = json.loads(
        (JSON_SCHEMA_DIR / "garmin-series-outcome.json").read_text(encoding="utf-8")
    )
    outcomes = [series["outcome"] for series in response.json()["series"]]
    assert outcomes == ["ok", "gone", "failed", "failed", "skipped"]
    assert list(dict.fromkeys(outcomes)) == schema["enum"]


@pytest.mark.parametrize(
    "garmin",
    [
        ScriptedGarmin(personal_records={"records": []}),
        ScriptedGarmin(personal_records=[{"typeId": 3, "value": "27:05"}, {"typeId": 7}]),
        ScriptedGarmin(details={"activityDetailMetrics": "7028 rows"}),
        ScriptedGarmin(
            details={
                "metricDescriptors": [
                    {"metricsIndex": 0, "key": "sumDuration"},
                    {"metricsIndex": 1, "key": "sumDistance"},
                ],
                "activityDetailMetrics": [
                    {"metrics": [0.0, 0.0]},
                    {"metrics": [5.0, 12.0]},
                    {"metrics": [4.0, 13.0]},
                    {"metrics": [float("inf"), 14.0]},
                ],
            }
        ),
    ],
)
def test_series_responses_from_unexpected_garmin_answers_match_garmin_series_response(
    make_client: AppFactory, garmin: ScriptedGarmin
) -> None:
    response = make_client(connect=garmin.connect()).post(
        "/activities/series",
        json={"tokenBundle": bundle(), "garminActivityIds": [42], "includeRecords": True},
    )

    assert response.status_code == 200
    assert_series_response_valid(response.json())


def assert_series_response_valid(body: dict[str, Any]) -> None:
    assert_valid("garmin-series-response", body)
    for series in body["series"]:
        assert_valid("garmin-activity-series", series)
        assert_valid("garmin-series-outcome", series["outcome"])
        # The zod refinements JSON Schema cannot carry.
        assert len(series["distanceM"]) == len(series["elapsedS"])
        assert series["outcome"] == "ok" or series["elapsedS"] == []
    for record in body["records"] or []:
        assert_valid("garmin-record", record)


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
        "series_rotate_then_rate_limited": client.post(
            "/activities/series",
            json={
                "tokenBundle": bundle(fixture="rotate_then_rate_limited"),
                "garminActivityIds": [10_000_000_007],
                "includeRecords": True,
            },
        ),
        "series_validation": client.post(
            "/activities/series",
            json={
                "tokenBundle": bundle(),
                "garminActivityIds": list(range(1, 12)),
                "includeRecords": False,
            },
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
        "series_rotate_then_rate_limited": 429,
        "series_validation": 400,
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
        "series_rotate_then_rate_limited",
    }


def test_every_error_code_of_the_service_is_a_shared_code() -> None:
    schema = json.loads((JSON_SCHEMA_DIR / "garmin-problem.json").read_text(encoding="utf-8"))
    shared_codes = set(schema["properties"]["code"]["enum"])

    assert {code.value for code in ErrorCode} <= shared_codes
