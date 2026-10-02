"""POST /history through the real app, with the fixture fake or a scripted Garmin behind it.

The fake account is sync.json plus history.json: 49 items newest first, 46 runs and 3 non-runs.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from garminconnect import GarminConnectTooManyRequestsError

from tests.conftest import AppFactory
from tests.helpers import BASE_BUNDLE, ScriptedGarmin, bundle, by_id, raw_run, rotated

ACCOUNT_ITEMS = 49
ACCOUNT_RUNS = 46
WALKING = 9_000_000_040
CYCLING = 9_000_000_031
STRENGTH = 9_000_000_017
TREADMILL_WITH_HR = 9_000_000_038
TREADMILL_WITHOUT_HR = 9_000_000_025
MANUAL = 9_000_000_027
HR_ZERO = 9_000_000_035
TRAIL = 9_000_000_036
VIRTUAL = 9_000_000_023
SUNDAY_LATE_IN_NEW_YORK = 9_000_000_013
DST_CHANGE_DAY = 9_000_000_026


def history_body(**overrides: Any) -> dict[str, Any]:
    return {"tokenBundle": bundle(), "start": 0, "limit": 10, **overrides}


def ids(body: dict[str, Any]) -> list[int]:
    return [activity["garminActivityId"] for activity in body["activities"]]


def whole_account(make_client: AppFactory) -> dict[str, Any]:
    response = make_client().post("/history", json=history_body(limit=200))
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


def test_returns_the_first_page_newest_first_runs_only_with_the_unchanged_bundle(
    make_client: AppFactory,
) -> None:
    sent = bundle()

    response = make_client().post("/history", json=history_body(tokenBundle=sent))

    assert response.status_code == 200
    body = response.json()
    assert body["tokenBundle"] == sent
    # The 7 sync.json runs, then the newest history items; the walk among them is dropped.
    assert ids(body) == [*range(10_000_000_007, 10_000_000_000, -1), 9_000_000_042, 9_000_000_041]
    assert WALKING not in ids(body)
    assert body["listed"] == 10


def test_listed_counts_the_non_runs_garmin_returned_although_they_are_dropped(
    make_client: AppFactory,
) -> None:
    body = whole_account(make_client)

    assert body["listed"] == ACCOUNT_ITEMS
    assert len(body["activities"]) == ACCOUNT_RUNS
    assert {WALKING, CYCLING, STRENGTH}.isdisjoint(ids(body))
    assert ids(body) == sorted(ids(body), reverse=True)


def test_drops_non_runs_although_the_fake_ignores_the_running_filter(
    make_client: AppFactory,
) -> None:
    types = {activity["type"] for activity in whole_account(make_client)["activities"]}

    assert types == {"running", "treadmill_running", "trail_running", "virtual_run"}


def test_pages_to_the_end_where_the_last_page_lists_fewer_than_the_limit(
    make_client: AppFactory,
) -> None:
    client = make_client()
    listed: list[int] = []
    paged: list[int] = []
    start = 0
    while True:
        body = client.post("/history", json=history_body(start=start, limit=10)).json()
        listed.append(body["listed"])
        paged.extend(ids(body))
        start += body["listed"]
        if body["listed"] < 10:
            break

    assert listed == [10, 10, 10, 10, 9]
    assert paged == ids(whole_account(make_client))
    assert len(set(paged)) == ACCOUNT_RUNS


def test_returns_an_empty_page_past_the_end(make_client: AppFactory) -> None:
    response = make_client().post("/history", json=history_body(start=ACCOUNT_ITEMS))

    assert response.status_code == 200
    assert (response.json()["activities"], response.json()["listed"]) == ([], 0)


def test_maps_a_treadmill_run_with_hr_as_indoor_without_elevation(
    make_client: AppFactory,
) -> None:
    treadmill = by_id(whole_account(make_client)["activities"])[TREADMILL_WITH_HR]

    assert treadmill["type"] == "treadmill_running"
    assert (treadmill["isIndoor"], treadmill["elevationGainM"]) == (True, None)
    assert (treadmill["avgHr"], treadmill["maxHr"]) == (151.0, 168.0)


def test_returns_null_hr_for_a_treadmill_run_without_hr(make_client: AppFactory) -> None:
    treadmill = by_id(whole_account(make_client)["activities"])[TREADMILL_WITHOUT_HR]

    assert (treadmill["avgHr"], treadmill["maxHr"]) == (None, None)
    assert treadmill["isIndoor"] is True
    assert treadmill["cadence"] == 171.0


def test_flags_a_manual_run_and_leaves_hr_cadence_and_elevation_null(
    make_client: AppFactory,
) -> None:
    manual = by_id(whole_account(make_client)["activities"])[MANUAL]

    assert manual["isManual"] is True
    assert (manual["avgHr"], manual["maxHr"]) == (None, None)
    assert (manual["cadence"], manual["elevationGainM"]) == (None, None)
    assert (manual["distanceM"], manual["durationS"]) == (5000.0, 1800.0)


def test_reports_an_outdoor_run_with_hr_zero_as_missing_hr(make_client: AppFactory) -> None:
    no_hr = by_id(whole_account(make_client)["activities"])[HR_ZERO]

    assert (no_hr["avgHr"], no_hr["maxHr"]) == (None, None)
    assert no_hr["isIndoor"] is False
    assert no_hr["cadence"] == 170.0


def test_keeps_trail_running_outdoor_and_virtual_run_indoor(make_client: AppFactory) -> None:
    activities = by_id(whole_account(make_client)["activities"])

    assert (activities[TRAIL]["type"], activities[TRAIL]["isIndoor"]) == ("trail_running", False)
    assert activities[TRAIL]["elevationGainM"] == 420.0
    assert (activities[VIRTUAL]["type"], activities[VIRTUAL]["isIndoor"]) == ("virtual_run", True)


def test_keeps_the_local_sunday_of_a_run_late_on_sunday_whose_utc_start_is_monday(
    make_client: AppFactory,
) -> None:
    late = by_id(whole_account(make_client)["activities"])[SUNDAY_LATE_IN_NEW_YORK]

    assert late["startLocal"] == "2025-03-30T23:30:00"
    assert late["startUtc"] == "2025-03-31T03:30:00Z"


def test_takes_the_utc_start_of_a_run_on_a_dst_change_day_from_garmin(
    make_client: AppFactory,
) -> None:
    # Amsterdam moved to UTC+2 at 02:00 that morning; the day before was UTC+1.
    dst_day = by_id(whole_account(make_client)["activities"])[DST_CHANGE_DAY]

    assert (dst_day["startLocal"], dst_day["startUtc"]) == (
        "2026-03-29T09:00:00",
        "2026-03-29T07:00:00Z",
    )


def test_asks_garmin_for_one_page_of_running_activities(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin()

    make_client(connect=garmin.connect()).post("/history", json=history_body(start=20, limit=10))

    assert garmin.calls == ["login", "get_activities:20:10:running"]


def test_returns_a_repeated_id_within_one_page_once(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin(
        activities=[
            raw_run(),
            raw_run(),
            raw_run(activityId=42, activityType={"typeKey": "cycling"}),
            raw_run(activityId=43, activityType={"typeKey": "trail_running"}),
        ]
    )

    body = make_client(connect=garmin.connect()).post("/history", json=history_body()).json()

    assert ids(body) == [10_000_000_007, 43]
    assert body["listed"] == 4


def test_keeps_runs_of_any_date_since_history_has_no_date_range(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        activities=[
            raw_run(
                activityId=44,
                startTimeLocal="2014-05-04 08:00:00",
                startTimeGMT="2014-05-04 06:00:00",
            )
        ]
    )

    body = make_client(connect=garmin.connect()).post("/history", json=history_body()).json()

    assert ids(body) == [44]
    assert body["activities"][0]["startLocal"] == "2014-05-04T08:00:00"


def test_returns_502_garmin_unavailable_when_garmin_answers_an_object_instead_of_a_list(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(list_answer={"activityList": []})

    response = make_client(connect=garmin.connect()).post("/history", json=history_body())

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


def test_returns_502_and_logs_no_values_when_an_item_has_an_unexpected_shape(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    broken = raw_run()
    del broken["startTimeGMT"]
    garmin = ScriptedGarmin(activities=[broken])

    response = make_client(connect=garmin.connect()).post("/history", json=history_body())

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"
    logs = capsys.readouterr().out
    assert "startTimeGMT" in logs
    assert "2026-09-27" not in logs


@pytest.mark.parametrize(
    "overrides",
    [
        {"limit": 0},
        {"limit": 201},
        {"start": -1},
        {"start": "0"},
        {"limit": 10.5},
        {"limit": True},
        {"extra": 1},
    ],
)
def test_returns_400_validation_for_a_bad_page(
    make_client: AppFactory, overrides: dict[str, Any]
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(connect=garmin.connect()).post(
        "/history", json=history_body(**overrides)
    )

    assert response.status_code == 400
    assert response.json()["code"] == "validation"
    assert garmin.calls == []


@pytest.mark.parametrize("limit", [1, 200])
def test_accepts_the_limit_bounds(make_client: AppFactory, limit: int) -> None:
    response = make_client().post("/history", json=history_body(limit=limit))

    assert response.status_code == 200
    assert response.json()["listed"] == min(limit, ACCOUNT_ITEMS)


def test_returns_401_unauthorized_and_never_calls_garmin_when_the_secret_is_wrong(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(secret_header="nope", connect=garmin.connect()).post(
        "/history", json=history_body()
    )

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert garmin.calls == []


def test_returns_401_garmin_auth_expired_when_the_login_expired(make_client: AppFactory) -> None:
    response = make_client().post(
        "/history", json=history_body(tokenBundle=bundle(fixture="expired"))
    )

    assert response.status_code == 401
    assert response.json()["code"] == "garmin_auth_expired"


def test_returns_429_with_retry_after_when_garmin_rate_limits(make_client: AppFactory) -> None:
    response = make_client().post(
        "/history", json=history_body(tokenBundle=bundle(fixture="rate_limited"))
    )

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    assert response.json()["code"] == "garmin_rate_limited"
    assert response.json()["retryAfterSeconds"] == 3600


def test_returns_429_and_does_not_retry_when_the_list_call_is_rate_limited(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        activities_error=GarminConnectTooManyRequestsError("Rate limit exceeded: API Error 429")
    )

    response = make_client(connect=garmin.connect()).post("/history", json=history_body())

    assert response.status_code == 429
    assert response.json()["code"] == "garmin_rate_limited"
    assert "tokenBundle" not in response.json()
    assert garmin.calls == ["login", "get_activities:0:10:running"]


def test_returns_502_garmin_unavailable_when_garmin_is_down(make_client: AppFactory) -> None:
    response = make_client().post(
        "/history", json=history_body(tokenBundle=bundle(fixture="unavailable"))
    )

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


def test_returns_the_rotated_bundle_with_the_page(make_client: AppFactory) -> None:
    client = make_client()
    unchanged = client.post("/history", json=history_body()).json()

    response = client.post("/history", json=history_body(tokenBundle=bundle(fixture="rotate")))

    assert response.status_code == 200
    body = response.json()
    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}
    assert (body["activities"], body["listed"]) == (unchanged["activities"], unchanged["listed"])


def test_returns_429_with_the_rotated_bundle_when_rotate_then_rate_limited(
    make_client: AppFactory,
) -> None:
    sent = bundle(fixture="rotate_then_rate_limited")

    response = make_client().post("/history", json=history_body(tokenBundle=sent))

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    body = response.json()
    assert (body["code"], body["retryAfterSeconds"]) == ("garmin_rate_limited", 3600)
    assert body["tokenBundle"] == rotated(sent)
    assert json.loads(body["tokenBundle"])["fixture"] == "rotated"


def test_returns_502_with_the_rotated_bundle_when_rotate_then_unavailable(
    make_client: AppFactory,
) -> None:
    sent = bundle(fixture="rotate_then_unavailable")

    response = make_client().post("/history", json=history_body(tokenBundle=sent))

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"
    assert json.loads(response.json()["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


def test_returns_the_rotated_bundle_with_a_502_when_an_item_breaks_after_login(
    make_client: AppFactory,
) -> None:
    broken = raw_run()
    del broken["activityId"]
    new_bundle = rotated(bundle())
    garmin = ScriptedGarmin(rotate_to=new_bundle, activities=[broken])

    response = make_client(connect=garmin.connect()).post("/history", json=history_body())

    assert response.status_code == 502
    assert response.json()["tokenBundle"] == new_bundle
