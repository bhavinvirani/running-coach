"""POST /sync through the real app, with the fixture fake or a scripted Garmin behind it."""

from __future__ import annotations

import json
from typing import Any

import pytest
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

from garmin_service.fake_client import FAKE_DELETED_ACTIVITY_ID
from tests.conftest import AppFactory
from tests.helpers import (
    BASE_BUNDLE,
    ScriptedGarmin,
    bundle,
    by_id,
    raw_run,
    read_fixture,
    rotated,
)

FULL_RANGE = {"startDate": "2026-08-31", "endDate": "2026-09-27"}
# The 10.2 km run the runner tagged as a race in Garmin Connect.
RACE = 10_000_000_002
# What the API asks for on its last chunk (RECENT_RUNS_CHECKED in packages/shared).
RECENT_LIMIT = 100
# The fake account: 49 items newest first, 46 runs, the oldest of 2023-09-17.
ACCOUNT_ITEMS = 49
ACCOUNT_RUNS = 46
OLDEST_RUN_START = "2023-09-17T07:00:00Z"
OLDEST_RUN_START_LOCAL = "2023-09-17T09:00:00"


def outage() -> Exception:
    """What garminconnect raises for a 503 once its retries ran out."""
    error = GarminConnectConnectionError("API call HTTP error")
    error.__cause__ = GarminConnectConnectionError("API Error 503")
    return error


def sync_body(**overrides: Any) -> dict[str, Any]:
    """A chunk before the last: the API asks for the newest runs on its last chunk only."""
    return {"tokenBundle": bundle(), **FULL_RANGE, "recentLimit": 0, **overrides}


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
        "eventType": "uncategorized",
    }


def test_carries_the_event_type_the_runner_set_race_or_uncategorized(
    make_client: AppFactory,
) -> None:
    activities = by_id(make_client().post("/sync", json=sync_body()).json()["activities"])

    assert activities[RACE]["eventType"] == "race"
    assert activities[10_000_000_005]["eventType"] == "uncategorized"
    assert [a for a, run in activities.items() if run["eventType"] == "race"] == [RACE]


@pytest.mark.parametrize("sent", ["absent", "null"])
def test_returns_null_event_type_and_keeps_the_run_when_garmin_sends_no_event_type(
    make_client: AppFactory, sent: str
) -> None:
    item = raw_run(eventType=None)
    if sent == "absent":
        del item["eventType"]
    garmin = ScriptedGarmin(activities=[item])

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert response.status_code == 200
    [summary] = response.json()["activities"]
    assert (summary["garminActivityId"], summary["eventType"]) == (10_000_000_007, None)


@pytest.mark.parametrize(
    "event_type",
    [{}, {"typeKey": ""}, {"typeKey": None}, {"typeKey": 1}, "race", ["race"]],
)
def test_returns_null_event_type_and_keeps_the_run_when_the_event_type_is_malformed(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str], event_type: object
) -> None:
    garmin = ScriptedGarmin(activities=[raw_run(eventType=event_type)])

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert response.status_code == 200
    [summary] = response.json()["activities"]
    assert (summary["garminActivityId"], summary["eventType"]) == (10_000_000_007, None)
    assert summary["distanceM"] == 18000.0
    assert '"race"' not in capsys.readouterr().out


def test_logs_the_malformed_event_type_shape_without_its_value(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = ScriptedGarmin(activities=[raw_run(eventType={"typeKey": "", "typeId": 31337})])

    make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    logs = capsys.readouterr().out
    assert "eventType" in logs
    assert "31337" not in logs


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


def test_returns_429_with_the_rotated_bundle_when_garmin_rate_limits_after_login_rotated_the_tokens(
    make_client: AppFactory,
) -> None:
    sent = bundle(fixture="rotate_then_rate_limited")

    response = make_client().post("/sync", json=sync_body(tokenBundle=sent))

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    body = response.json()
    assert body["code"] == "garmin_rate_limited"
    assert body["retryAfterSeconds"] == 3600
    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


def test_returns_502_with_the_rotated_bundle_when_garmin_fails_after_login_rotated_the_tokens(
    make_client: AppFactory,
) -> None:
    sent = bundle(fixture="rotate_then_unavailable")

    response = make_client().post("/sync", json=sync_body(tokenBundle=sent))

    assert response.status_code == 502
    body = response.json()
    assert body["code"] == "garmin_unavailable"
    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


def test_the_rotated_bundle_from_a_failed_sync_works_on_the_next_sync(
    make_client: AppFactory,
) -> None:
    client = make_client()
    failed = client.post(
        "/sync", json=sync_body(tokenBundle=bundle(fixture="rotate_then_unavailable"))
    )

    retried = client.post("/sync", json=sync_body(tokenBundle=failed.json()["tokenBundle"]))

    assert retried.status_code == 200
    assert retried.json()["tokenBundle"] == failed.json()["tokenBundle"]


def test_returns_no_bundle_with_an_error_when_the_tokens_did_not_rotate(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        activities_error=GarminConnectTooManyRequestsError("Rate limit exceeded")
    )

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert response.status_code == 429
    assert "tokenBundle" not in response.json()


def test_returns_the_rotated_bundle_with_a_500_when_the_route_crashes_after_login(
    make_client: AppFactory,
) -> None:
    new_bundle = rotated(bundle())
    garmin = ScriptedGarmin(rotate_to=new_bundle, activities_error=RuntimeError("boom"))

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert response.status_code == 500
    assert response.json()["code"] == "internal"
    assert response.json()["tokenBundle"] == new_bundle


def test_returns_the_rotated_bundle_with_a_502_when_garmin_changes_the_item_shape_after_login(
    make_client: AppFactory,
) -> None:
    broken = raw_run()
    del broken["activityId"]
    new_bundle = rotated(bundle())
    garmin = ScriptedGarmin(rotate_to=new_bundle, activities=[broken])

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body())

    assert response.status_code == 502
    assert response.json()["tokenBundle"] == new_bundle


def test_answers_the_newest_runs_ids_oldest_start_and_listed_count_when_asked(
    make_client: AppFactory,
) -> None:
    response = make_client().post("/sync", json=sync_body(recentLimit=RECENT_LIMIT))

    assert response.status_code == 200
    recent = response.json()["recent"]
    assert len(recent["garminActivityIds"]) == ACCOUNT_RUNS
    assert recent["garminActivityIds"][:3] == [10_000_000_007, 10_000_000_006, 10_000_000_005]
    assert recent["oldestStartUtc"] == OLDEST_RUN_START
    assert recent["oldestStartLocal"] == OLDEST_RUN_START_LOCAL
    # Fewer than asked for: the list reached the account's first run.
    assert recent["listed"] == ACCOUNT_ITEMS
    assert len(response.json()["activities"]) == len(read_fixture("sync.json"))


def test_lists_the_newest_runs_with_one_more_call_under_the_same_login(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(activities=[raw_run()])

    make_client(connect=garmin.connect()).post("/sync", json=sync_body(recentLimit=RECENT_LIMIT))

    assert garmin.calls == [
        "login",
        "get_activities_by_date:2026-08-31:2026-09-27:running",
        "get_activities:0:100:running",
    ]


def test_skips_the_newest_runs_call_and_answers_recent_null_when_recent_limit_is_0(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(activities=[raw_run()])

    response = make_client(connect=garmin.connect()).post("/sync", json=sync_body(recentLimit=0))

    assert response.status_code == 200
    assert response.json()["recent"] is None
    assert not any(call.startswith("get_activities:") for call in garmin.calls)


def test_answers_only_the_newest_items_up_to_the_limit(make_client: AppFactory) -> None:
    response = make_client().post("/sync", json=sync_body(recentLimit=3))

    recent = response.json()["recent"]
    assert recent["garminActivityIds"] == [10_000_000_007, 10_000_000_006, 10_000_000_005]
    assert recent["oldestStartUtc"] == "2026-09-20T05:45:00Z"
    assert recent["oldestStartLocal"] == "2026-09-20T07:45:00"
    assert recent["listed"] == 3


def test_answers_the_earliest_local_and_utc_starts_each_on_its_own_clock_when_their_orders_differ(
    make_client: AppFactory,
) -> None:
    """Time zones and DST: a run in Tokyo (UTC+9), a flight over the date line, a run in Honolulu
    (UTC-10). Garmin lists newest first by local start, so the last item holds the earliest local
    start but not the earliest UTC one."""
    garmin = ScriptedGarmin(
        activities=[raw_run()],
        list_answer=[
            raw_run(
                activityId=43,
                startTimeLocal="2026-09-20 07:00:00",
                startTimeGMT="2026-09-20 17:00:00",
            ),
            raw_run(
                activityId=42,
                startTimeLocal="2026-09-19 20:00:00",
                startTimeGMT="2026-09-19 11:00:00",
            ),
            raw_run(
                activityId=41,
                startTimeLocal="2026-09-19 12:00:00",
                startTimeGMT="2026-09-19 22:00:00",
            ),
        ],
    )

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    recent = response.json()["recent"]
    assert recent["garminActivityIds"] == [43, 42, 41]
    assert recent["oldestStartLocal"] == "2026-09-19T12:00:00"
    assert recent["oldestStartUtc"] == "2026-09-19T11:00:00Z"


def test_leaves_a_run_whose_type_changed_away_from_running_out_of_the_newest_runs_but_counts_it(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        activities=[
            raw_run(),
            raw_run(),
            raw_run(activityId=42, activityType={"typeKey": "walking"}),
            raw_run(activityId=43, activityType={"typeKey": "trail_running"}),
        ]
    )

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    recent = response.json()["recent"]
    # The same filter as the by-date list: runs only, each id once.
    assert recent["garminActivityIds"] == [10_000_000_007, 43]
    assert recent["garminActivityIds"] == [
        a["garminActivityId"] for a in response.json()["activities"]
    ]
    assert recent["listed"] == 4


def test_answers_a_null_oldest_start_when_the_newest_items_hold_no_run(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(activities=[raw_run(activityType={"typeKey": "cycling"})])

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    assert response.json()["recent"] == {
        "garminActivityIds": [],
        "oldestStartUtc": None,
        "oldestStartLocal": None,
        "listed": 1,
    }


def test_leaves_the_run_deleted_on_garmin_out_of_both_lists_with_the_deleted_run_bundle(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        "/sync",
        json=sync_body(tokenBundle=bundle(fixture="deleted_run"), recentLimit=RECENT_LIMIT),
    )

    assert response.status_code == 200
    body = response.json()
    assert FAKE_DELETED_ACTIVITY_ID not in [a["garminActivityId"] for a in body["activities"]]
    assert len(body["activities"]) == len(read_fixture("sync.json")) - 1
    assert FAKE_DELETED_ACTIVITY_ID not in body["recent"]["garminActivityIds"]
    assert len(body["recent"]["garminActivityIds"]) == ACCOUNT_RUNS - 1
    assert body["recent"]["listed"] == ACCOUNT_ITEMS - 1


def test_answers_recent_null_with_the_activities_intact_when_the_newest_runs_call_fails(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = ScriptedGarmin(activities=[raw_run()], recent_error=outage())

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    assert response.status_code == 200
    body = response.json()
    assert body["recent"] is None
    assert [a["garminActivityId"] for a in body["activities"]] == [10_000_000_007]
    assert "could not list the newest runs" in capsys.readouterr().out


def test_answers_recent_null_with_the_activities_intact_when_the_newest_runs_are_not_a_list(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(activities=[raw_run()], list_answer={"activities": []})

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    assert response.status_code == 200
    assert response.json()["recent"] is None
    assert len(response.json()["activities"]) == 1


def test_answers_recent_null_when_an_older_item_in_the_newest_runs_has_an_unreadable_shape(
    make_client: AppFactory,
) -> None:
    broken = raw_run(activityId=42, startTimeLocal="2026-08-01 07:00:00")
    del broken["startTimeGMT"]
    garmin = ScriptedGarmin(activities=[raw_run()], list_answer=[raw_run(), broken])

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    assert response.status_code == 200
    assert response.json()["recent"] is None
    assert [a["garminActivityId"] for a in response.json()["activities"]] == [10_000_000_007]


def test_returns_429_with_the_rotated_bundle_when_the_newest_runs_call_is_rate_limited(
    make_client: AppFactory,
) -> None:
    new_bundle = rotated(bundle())
    garmin = ScriptedGarmin(
        activities=[raw_run()],
        rotate_to=new_bundle,
        recent_error=GarminConnectTooManyRequestsError("Rate limit exceeded: API Error 429"),
    )

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    # Every later call would be limited too: the API must start its hour, not sync on.
    assert response.status_code == 429
    assert response.json()["code"] == "garmin_rate_limited"
    assert response.json()["tokenBundle"] == new_bundle


def test_returns_401_when_the_login_dies_before_the_newest_runs_call(
    make_client: AppFactory,
) -> None:
    error = GarminConnectAuthenticationError("Unauthorized")
    error.__cause__ = GarminConnectConnectionError("API Error 401")
    garmin = ScriptedGarmin(activities=[raw_run()], recent_error=error)

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    assert response.status_code == 401
    assert response.json()["code"] == "garmin_auth_expired"


def test_returns_500_when_the_newest_runs_call_fails_with_a_bug(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin(activities=[raw_run()], recent_error=RuntimeError("boom"))

    response = make_client(connect=garmin.connect()).post(
        "/sync", json=sync_body(recentLimit=RECENT_LIMIT)
    )

    assert response.status_code == 500
    assert response.json()["code"] == "internal"


def test_returns_the_rotated_bundle_with_the_activities_and_the_newest_runs(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        "/sync", json=sync_body(tokenBundle=bundle(fixture="rotate"), recentLimit=RECENT_LIMIT)
    )

    assert response.status_code == 200
    body = response.json()
    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}
    assert len(body["recent"]["garminActivityIds"]) == ACCOUNT_RUNS


@pytest.mark.parametrize("recent_limit", [-1, 201, "100", None])
def test_returns_400_validation_for_a_bad_recent_limit(
    make_client: AppFactory, recent_limit: object
) -> None:
    response = make_client().post("/sync", json=sync_body(recentLimit=recent_limit))

    assert response.status_code == 400
    assert response.json()["code"] == "validation"


def test_returns_400_validation_without_a_recent_limit(make_client: AppFactory) -> None:
    body = sync_body()
    del body["recentLimit"]

    response = make_client().post("/sync", json=body)

    assert response.status_code == 400
    assert response.json()["code"] == "validation"
