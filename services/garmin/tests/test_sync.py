"""POST /sync through the real app, with the fixture fake or a scripted Garmin behind it."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest
from garminconnect import GarminConnectTooManyRequestsError

from tests.conftest import AppFactory
from tests.helpers import BASE_BUNDLE, ScriptedGarmin, bundle, read_fixture

FULL_RANGE = {"startDate": "2026-08-31", "endDate": "2026-09-27"}


def sync_body(**overrides: str) -> dict[str, str]:
    return {"tokenBundle": bundle(), **FULL_RANGE, **overrides}


def by_id(activities: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {activity["garminActivityId"]: activity for activity in activities}


def raw_run(**overrides: Any) -> dict[str, Any]:
    """The long run from sync.json, with fields replaced."""
    item: dict[str, Any] = copy.deepcopy(read_fixture("sync.json")[0])
    item.update(overrides)
    return item


def test_returns_every_fixture_run_newest_first_with_the_unchanged_bundle(
    make_client: AppFactory,
) -> None:
    sent = bundle()
    response = make_client().post("/sync", json=sync_body(tokenBundle=sent))

    assert response.status_code == 200
    body = response.json()
    assert body["tokenBundle"] == sent
    ids = [activity["garminActivityId"] for activity in body["activities"]]
    assert ids == sorted(ids, reverse=True)
    assert len(ids) == len(read_fixture("sync.json"))


def test_maps_an_outdoor_run_to_the_shared_summary(make_client: AppFactory) -> None:
    activities = make_client().post("/sync", json=sync_body()).json()["activities"]

    assert by_id(activities)[10_000_000_007] == {
        "garminActivityId": 10_000_000_007,
        "type": "running",
        "startUtc": "2026-09-27T06:00:00Z",
        "startLocal": "2026-09-27T08:00:00",
        "tz": None,
        "distanceM": 18000.0,
        "durationS": 6120.0,
        "avgHr": 148.0,
        "maxHr": 166.0,
        "cadence": 168.0,
        "calories": 1150.0,
        "elevationGainM": 142.0,
        "isIndoor": False,
        "isManual": False,
    }


def test_marks_a_treadmill_run_indoor_without_elevation(make_client: AppFactory) -> None:
    activities = make_client().post("/sync", json=sync_body()).json()["activities"]

    treadmill = by_id(activities)[10_000_000_006]
    assert treadmill["type"] == "treadmill_running"
    assert treadmill["isIndoor"] is True
    assert treadmill["elevationGainM"] is None


@pytest.mark.parametrize("type_key", ["treadmill_running", "indoor_running", "virtual_run"])
def test_treats_every_indoor_type_as_indoor(make_client: AppFactory, type_key: str) -> None:
    garmin = ScriptedGarmin(activities=[raw_run(activityType={"typeKey": type_key})])

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert response.json()["activities"][0]["isIndoor"] is True


def test_returns_null_heart_rate_when_garmin_has_none(make_client: AppFactory) -> None:
    activities = make_client().post("/sync", json=sync_body()).json()["activities"]

    no_hr = by_id(activities)[10_000_000_004]
    assert no_hr["avgHr"] is None
    assert no_hr["maxHr"] is None
    assert no_hr["cadence"] == 170.0


def test_reports_zero_heart_rate_and_cadence_as_missing(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin(
        activities=[raw_run(averageHR=0, maxHR=0.0, averageRunningCadenceInStepsPerMinute=0)]
    )

    activity = make_client(connect=garmin.connect()).post("/sync", json=sync_body()).json()
    summary = activity["activities"][0]

    assert (summary["avgHr"], summary["maxHr"], summary["cadence"]) == (None, None, None)


def test_flags_a_manual_run_and_leaves_sensor_fields_null(make_client: AppFactory) -> None:
    activities = make_client().post("/sync", json=sync_body()).json()["activities"]

    manual = by_id(activities)[10_000_000_003]
    assert manual["isManual"] is True
    assert (manual["avgHr"], manual["cadence"], manual["elevationGainM"]) == (None, None, None)
    assert manual["distanceM"] == 5000.0


@pytest.mark.parametrize(
    ("start", "end", "expected_ids"),
    [
        # Local start 2026-08-31 00:40 is 2026-08-30 22:40 UTC: the local date decides.
        ("2026-08-31", "2026-08-31", [10_000_000_001]),
        ("2026-08-30", "2026-08-30", []),
        ("2026-09-13", "2026-09-19", [10_000_000_004]),
        ("2026-09-27", "2026-09-27", [10_000_000_007]),
        ("2026-10-01", "2026-10-31", []),
    ],
)
def test_returns_only_runs_whose_local_start_date_is_in_the_range(
    make_client: AppFactory, start: str, end: str, expected_ids: list[int]
) -> None:
    response = make_client().post("/sync", json=sync_body(startDate=start, endDate=end))

    assert response.status_code == 200
    assert [a["garminActivityId"] for a in response.json()["activities"]] == expected_ids


def test_asks_garmin_for_running_activities_in_the_range(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin()

    make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert garmin.calls == ["login", "get_activities_by_date:2026-08-31:2026-09-27:running"]


def test_drops_non_runs_repeats_and_out_of_range_items_garmin_returns(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        activities=[
            raw_run(),
            raw_run(),
            raw_run(activityId=42, activityType={"typeKey": "cycling"}),
            raw_run(activityId=43, activityType={"typeKey": "trail_running"}),
            raw_run(activityId=44, startTimeLocal="2026-09-28 06:00:00"),
        ]
    )

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    ids = [a["garminActivityId"] for a in response.json()["activities"]]
    assert ids == [10_000_000_007, 43]


def test_returns_502_and_logs_no_values_when_garmin_changes_the_item_shape(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    broken = raw_run()
    del broken["startTimeGMT"]
    garmin = ScriptedGarmin(activities=[broken])

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"
    logs = capsys.readouterr().out
    assert "startTimeGMT" in logs
    assert "2026-09-27" not in logs


@pytest.mark.parametrize(
    "overrides",
    [
        {"startDate": "2026-09-28"},
        {"startDate": "2026-9-1"},
        {"endDate": "2026-09-27T00:00:00"},
    ],
)
def test_returns_400_validation_for_a_bad_range(
    make_client: AppFactory, overrides: dict[str, str]
) -> None:
    response = make_client().post("/sync", json=sync_body(**overrides))

    assert response.status_code == 400
    assert response.json()["code"] == "validation"


def test_returns_401_unauthorized_and_never_calls_garmin_when_the_secret_is_wrong(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(secret_header="nope", connect=garmin.connect()).post(
        "/sync", json=sync_body()
    )

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert garmin.calls == []


def test_returns_401_garmin_auth_expired_when_the_bundle_is_expired(
    make_client: AppFactory,
) -> None:
    response = make_client().post("/sync", json=sync_body(tokenBundle=bundle(fixture="expired")))

    assert response.status_code == 401
    assert response.json()["code"] == "garmin_auth_expired"


def test_returns_429_with_retry_after_when_garmin_rate_limits(make_client: AppFactory) -> None:
    response = make_client().post(
        "/sync", json=sync_body(tokenBundle=bundle(fixture="rate_limited"))
    )

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    assert response.json()["retryAfterSeconds"] == 3600


def test_returns_429_and_does_not_retry_when_the_list_call_is_rate_limited(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        activities_error=GarminConnectTooManyRequestsError("Rate limit exceeded: API Error 429")
    )

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert response.status_code == 429
    assert response.json()["code"] == "garmin_rate_limited"
    assert len(garmin.calls) == 2


def test_returns_502_garmin_unavailable_when_garmin_is_down(make_client: AppFactory) -> None:
    response = make_client().post(
        "/sync", json=sync_body(tokenBundle=bundle(fixture="unavailable"))
    )

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


def test_returns_the_rotated_bundle_with_the_activities(make_client: AppFactory) -> None:
    response = make_client().post("/sync", json=sync_body(tokenBundle=bundle(fixture="rotate")))

    assert response.status_code == 200
    body = response.json()
    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}
    assert len(body["activities"]) == len(read_fixture("sync.json"))
