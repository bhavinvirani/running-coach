"""POST /activities/series through the real app, with the fixture fake or a scripted Garmin.

Fixture values: detail-series.json has 551 rows of one sanitized run (16.67 km in 6532 timer
seconds); personal-records.json is made up in the captured shape, with the distance records 1 to 5,
the longest run 7 and the step and goal records 12 to 16.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
import requests
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectNotFoundError,
    GarminConnectTooManyRequestsError,
)

from garmin_service.errors import from_garmin_exception
from garmin_service.fake_client import (
    FAKE_UNAVAILABLE_ACTIVITY_ID,
    FAKE_UNAVAILABLE_ACTIVITY_IDS,
    FakeGarmin,
)
from garmin_service.models.problem import ErrorCode
from garmin_service.routes import activity_series
from tests.conftest import AppFactory
from tests.helpers import BASE_BUNDLE, ScriptedGarmin, bundle, rotated

PATH = "/activities/series"
OUTDOOR = 10_000_000_007
TREADMILL = 10_000_000_006
NO_HR = 10_000_000_004
MANUAL = 10_000_000_003
VIRTUAL = 9_000_000_023
UNKNOWN = 12_345
UNAVAILABLE = FAKE_UNAVAILABLE_ACTIVITY_ID
(UNAVAILABLE_TOO,) = FAKE_UNAVAILABLE_ACTIVITY_IDS - {UNAVAILABLE}
FIXTURE_ROWS = 551
FIRST_ELAPSED = [0.0, 8.0]
FIRST_DISTANCE = [1.9600000381469727, 24.15999984741211]
LAST_ELAPSED = 6532.0
LAST_DISTANCE = 16666.970703125
# personal-records.json mapped: each run's start (activityStartDateTimeInGMT), not prStartTimeGmt.
FIXTURE_RECORDS = [
    {"distanceKey": "1k", "timeS": 288.41, "achievedAt": "2026-09-20T06:30:00Z"},
    {"distanceKey": "1mi", "timeS": 471.93, "achievedAt": "2026-09-20T06:30:00Z"},
    {"distanceKey": "5k", "timeS": 1702.36, "achievedAt": "2026-09-13T06:00:00Z"},
    {"distanceKey": "10k", "timeS": 3498.07, "achievedAt": "2026-09-13T06:00:00Z"},
    {"distanceKey": "half", "timeS": 7731.52, "achievedAt": "2026-08-30T05:45:00Z"},
]
SERIES_KEYS = ["sumDuration", "sumDistance", "directHeartRate"]


def series_body(
    ids: list[Any], *, include_records: Any = False, token_bundle: str | None = None
) -> dict[str, Any]:
    return {
        "tokenBundle": bundle() if token_bundle is None else token_bundle,
        "garminActivityIds": ids,
        "includeRecords": include_records,
    }


def fetch(make_client: AppFactory, ids: list[int], **kwargs: Any) -> dict[str, Any]:
    include_records = kwargs.pop("include_records", False)
    response = make_client(**kwargs).post(
        PATH, json=series_body(ids, include_records=include_records)
    )
    assert response.status_code == 200, response.json()
    body: dict[str, Any] = response.json()
    return body


def raw_details(rows: list[list[Any]], keys: list[str] = SERIES_KEYS) -> dict[str, Any]:
    """get_activity_details' shape: one descriptor per key, in column order."""
    return {
        "activityId": 42,
        "metricDescriptors": [{"metricsIndex": i, "key": key} for i, key in enumerate(keys)],
        "activityDetailMetrics": [{"metrics": row} for row in rows],
        "detailsAvailable": True,
    }


def record(type_id: int, value: float | str | None, **overrides: Any) -> dict[str, Any]:
    """One get_personal_record item in the captured shape; every value is made up."""
    item: dict[str, Any] = {
        "id": 9_100_000_100 + type_id,
        "typeId": type_id,
        "status": "ACCEPTED",
        "activityId": 91_009,
        "activityName": "Made-up run",
        "activityType": "running",
        "activityStartDateTimeInGMT": 1_789_279_200_000,  # 2026-09-13T06:00:00Z
        "actStartDateTimeInGMTFormatted": "2026-09-13T06:00:00.0",
        "activityStartDateTimeLocal": 1_789_286_400_000,
        "activityStartDateTimeLocalFormatted": "2026-09-13T08:00:00.0",
        "value": value,
        "prStartTimeGmt": 1_789_279_512_000,  # 2026-09-13T06:05:12Z
        "prStartTimeGmtFormatted": "2026-09-13T06:05:12.0",
        "prStartTimeLocal": None,
        "prStartTimeLocalFormatted": None,
        "prTypeLabelKey": None,
        "poolLengthUnit": None,
    }
    item.update(overrides)
    return item


def records_of(make_client: AppFactory, answer: Any) -> Any:
    garmin = ScriptedGarmin(personal_records=answer)
    return fetch(make_client, [], include_records=True, connect=garmin.connect())["records"]


def empty(garmin_activity_id: int, outcome: str) -> dict[str, Any]:
    return {
        "garminActivityId": garmin_activity_id,
        "outcome": outcome,
        "elapsedS": [],
        "distanceM": [],
    }


def outcomes(body: dict[str, Any]) -> list[str]:
    return [series["outcome"] for series in body["series"]]


def not_found_error() -> Exception:
    error = GarminConnectNotFoundError("API call client error (404): API Error 404")
    error.__cause__ = GarminConnectNotFoundError("API Error 404")
    return error


def garmin_down_error() -> Exception:
    """What garminconnect raises for a 503 once its retries ran out."""
    error = GarminConnectConnectionError("API call HTTP error: API Error 503")
    error.__cause__ = GarminConnectConnectionError("API Error 503")
    return error


def blocked_error() -> Exception:
    """What garminconnect raises for a 403 (in practice a Cloudflare or IP block)."""
    error = GarminConnectConnectionError("API call client error (403): API Error 403")
    error.__cause__ = GarminConnectConnectionError("API Error 403")
    return error


def network_error() -> Exception:
    """What garminconnect raises for a connection error once its retries ran out."""
    error = GarminConnectConnectionError("Connection error: connection reset")
    error.__cause__ = requests.ConnectionError("connection reset")
    return error


def rate_limited_error() -> Exception:
    error = GarminConnectTooManyRequestsError("Rate limit exceeded: API Error 429")
    error.__cause__ = GarminConnectConnectionError("API Error 429")
    return error


def auth_failed_error() -> Exception:
    """What garminconnect raises when Garmin answers a data call with 401."""
    error = GarminConnectAuthenticationError("Authentication failed: API Error 401")
    error.__cause__ = GarminConnectConnectionError("API Error 401")
    return error


def log_lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]


# Success on the fixture account.


def test_returns_each_runs_timer_and_distance_series_in_request_order(
    make_client: AppFactory,
) -> None:
    sent = bundle()
    response = make_client().post(
        PATH, json=series_body([NO_HR, OUTDOOR, TREADMILL], token_bundle=sent)
    )

    assert response.status_code == 200
    body = response.json()
    assert body["tokenBundle"] == sent
    assert body["records"] is None
    assert [s["garminActivityId"] for s in body["series"]] == [NO_HR, OUTDOOR, TREADMILL]
    assert outcomes(body) == ["ok", "ok", "ok"]
    for series in body["series"]:
        assert len(series["elapsedS"]) == len(series["distanceM"]) == FIXTURE_ROWS
        assert series["elapsedS"][:2] == FIRST_ELAPSED
        assert series["distanceM"][:2] == FIRST_DISTANCE
        assert (series["elapsedS"][-1], series["distanceM"][-1]) == (LAST_ELAPSED, LAST_DISTANCE)


def test_asks_for_full_rate_details_without_a_polyline_under_one_login_and_no_records_call(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    body = fetch(make_client, [42, 7], connect=garmin.connect())

    assert garmin.calls == [
        "login",
        "get_activity_details:42:10000:0",
        "get_activity_details:7:10000:0",
    ]
    assert body["records"] is None


def test_include_records_asks_garmin_for_its_records_once_after_the_series(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    body = fetch(make_client, [42, 7], include_records=True, connect=garmin.connect())

    assert garmin.calls == [
        "login",
        "get_activity_details:42:10000:0",
        "get_activity_details:7:10000:0",
        "get_personal_record",
    ]
    assert body["records"] == FIXTURE_RECORDS


def test_ok_gone_and_failed_runs_in_one_batch_answer_in_request_order(
    make_client: AppFactory,
) -> None:
    body = fetch(make_client, [OUTDOOR, UNKNOWN, UNAVAILABLE, MANUAL, VIRTUAL])

    assert [s["garminActivityId"] for s in body["series"]] == [
        OUTDOOR,
        UNKNOWN,
        UNAVAILABLE,
        MANUAL,
        VIRTUAL,
    ]
    assert outcomes(body) == ["ok", "gone", "failed", "ok", "ok"]
    assert body["series"][1] == empty(UNKNOWN, "gone")
    assert body["series"][2] == empty(UNAVAILABLE, "failed")
    assert body["series"][3] == empty(MANUAL, "ok")
    assert len(body["series"][0]["elapsedS"]) == len(body["series"][4]["elapsedS"]) == FIXTURE_ROWS


def test_deleted_run_an_id_outside_the_account_is_gone_while_the_others_succeed(
    make_client: AppFactory,
) -> None:
    series = fetch(make_client, [OUTDOOR, UNKNOWN, VIRTUAL])["series"]

    assert [s["garminActivityId"] for s in series] == [OUTDOOR, UNKNOWN, VIRTUAL]
    assert series[1] == empty(UNKNOWN, "gone")
    assert len(series[0]["elapsedS"]) == len(series[2]["elapsedS"]) == FIXTURE_ROWS


def test_deleted_run_after_login_rotated_still_returns_the_rotated_bundle(
    make_client: AppFactory,
) -> None:
    sent = bundle(fixture="rotate")
    response = make_client().post(PATH, json=series_body([UNKNOWN], token_bundle=sent))

    assert response.status_code == 200
    assert response.json()["tokenBundle"] == rotated(bundle())
    assert response.json()["series"] == [empty(UNKNOWN, "gone")]


def test_deleted_run_on_scripted_garmin_continues_to_the_next_id_and_the_records(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(details_errors={"5": not_found_error()})

    body = fetch(make_client, [5, 6], include_records=True, connect=garmin.connect())

    assert garmin.calls[-2:] == ["get_activity_details:6:10000:0", "get_personal_record"]
    assert body["series"][0] == empty(5, "gone")
    assert len(body["series"][1]["elapsedS"]) == FIXTURE_ROWS
    assert body["records"] == FIXTURE_RECORDS


def test_manual_entry_is_ok_with_empty_series(make_client: AppFactory) -> None:
    series = fetch(make_client, [MANUAL])["series"]

    assert series == [empty(MANUAL, "ok")]


def test_a_repeated_id_is_fetched_once_and_answered_at_each_position(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    series = fetch(make_client, [42, 7, 42], connect=garmin.connect())["series"]

    assert garmin.calls == [
        "login",
        "get_activity_details:42:10000:0",
        "get_activity_details:7:10000:0",
    ]
    assert [s["garminActivityId"] for s in series] == [42, 7, 42]
    assert series[0] == series[2]


def test_no_ids_and_no_records_makes_only_the_login(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin()

    body = fetch(make_client, [], connect=garmin.connect())

    assert body["series"] == []
    assert body["records"] is None
    assert garmin.calls == ["login"]


def test_fake_answers_maxpoly_zero_with_an_empty_polyline_and_the_fixture_rows() -> None:
    details = FakeGarmin().get_activity_details(str(OUTDOOR), maxchart=10_000, maxpoly=0)

    assert details["geoPolylineDTO"] == {"polyline": []}
    assert len(details["activityDetailMetrics"]) == FIXTURE_ROWS


@pytest.mark.parametrize("garmin_activity_id", [UNAVAILABLE, UNAVAILABLE_TOO])
def test_fake_unavailable_activity_ids_raise_what_errors_py_maps_to_garmin_unavailable(
    garmin_activity_id: int,
) -> None:
    with pytest.raises(GarminConnectConnectionError) as raised:
        FakeGarmin().get_activity_details(str(garmin_activity_id), maxchart=10_000, maxpoly=0)

    error = from_garmin_exception(raised.value)
    assert error is not None
    assert error.code is ErrorCode.GARMIN_UNAVAILABLE


def test_logs_counts_only_never_series_or_record_values(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    fetch(make_client, [OUTDOOR, UNKNOWN, UNAVAILABLE], include_records=True)

    lines = log_lines(capsys)
    fetched = next(line for line in lines if line["msg"] == "activity series fetched")
    keys = ("runs", "ok", "gone", "failed", "skipped", "rows", "records")
    assert {key: fetched[key] for key in keys} == {
        "runs": 3,
        "ok": 1,
        "gone": 1,
        "failed": 1,
        "skipped": 0,
        "rows": FIXTURE_ROWS,
        "records": len(FIXTURE_RECORDS),
    }
    text = json.dumps(lines)
    for value in ("16666.97", "6532", "1702.36", "fixture-token", "API Error 503"):
        assert value not in text


# Mapping the samples, on scripted answers.


def test_out_of_order_timer_rows_are_passed_through_in_garmins_order(
    make_client: AppFactory,
) -> None:
    details = raw_details(
        [
            [0.0, 0.0, 140.0],
            [3.0, 8.0, None],
            [2.5, 9.0, 143.0],
            [4.0, 11.0, 144.0],
            [4.0, 10.5, 144.0],
        ]
    )
    garmin = ScriptedGarmin(details=details)

    series = fetch(make_client, [42], connect=garmin.connect())["series"]

    assert series == [
        {
            "garminActivityId": 42,
            "outcome": "ok",
            "elapsedS": [0.0, 3.0, 2.5, 4.0, 4.0],
            "distanceM": [0.0, 8.0, 9.0, 11.0, 10.5],
        }
    ]


def test_drops_rows_missing_a_finite_non_negative_time_or_distance(
    make_client: AppFactory,
) -> None:
    details = raw_details(
        [
            [0.0, 0.0, 140.0],
            [None, 3.0, 141.0],
            [2.0, None, 142.0],
            [-1.0, 4.0, 142.0],
            [2.5, -0.5, 142.0],
            [float("nan"), 5.0, 142.0],
            [3.0, float("inf"), 142.0],
            [4.0, 11.0, 144.0],
        ]
    )
    garmin = ScriptedGarmin(details=details)

    series = fetch(make_client, [42], connect=garmin.connect())["series"]

    assert series == [
        {"garminActivityId": 42, "outcome": "ok", "elapsedS": [0.0, 4.0], "distanceM": [0.0, 11.0]}
    ]


@pytest.mark.parametrize(
    "details",
    [
        {**raw_details([[0.0, 0.0, 140.0]]), "detailsAvailable": False},
        raw_details([]),
        raw_details([[0.0, 140.0]], keys=["sumDistance", "directHeartRate"]),
        # What the library returns when Garmin answers 204 No Content.
        {},
    ],
)
def test_series_are_ok_and_empty_without_usable_rows(
    make_client: AppFactory, details: dict[str, Any]
) -> None:
    garmin = ScriptedGarmin(details=details)

    series = fetch(make_client, [42], connect=garmin.connect())["series"]

    assert series == [empty(42, "ok")]


@pytest.mark.parametrize(
    "details",
    [
        {"activityDetailMetrics": "7028 rows"},
        raw_details([[0.0, "8 km", 140.0]]),
        {"metricDescriptors": [{"metricsIndex": -1, "key": "sumDuration"}]},
    ],
)
def test_unexpected_details_shape_on_one_run_is_failed_while_the_others_succeed(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str], details: dict[str, Any]
) -> None:
    garmin = ScriptedGarmin(details_answers={"7": details})

    body = fetch(make_client, [42, 7, 8], include_records=True, connect=garmin.connect())

    assert outcomes(body) == ["ok", "failed", "ok"]
    assert body["series"][1] == empty(7, "failed")
    assert body["records"] == FIXTURE_RECORDS
    logs = capsys.readouterr().out
    assert "unexpected activity detail shape from Garmin" in logs
    assert "could not read one run's series, the batch goes on" in logs
    for value in ("7028 rows", "8 km"):
        assert value not in logs


# Garmin's records.


def test_include_records_maps_the_fixture_to_distance_keys_and_drops_type_ids_7_and_up(
    make_client: AppFactory,
) -> None:
    body = fetch(make_client, [], include_records=True)

    assert body["records"] == FIXTURE_RECORDS


def test_records_map_type_6_to_the_marathon_shortest_distance_first(
    make_client: AppFactory,
) -> None:
    answer = [record(6, 15012.5), record(3, 1625.25)]

    assert records_of(make_client, answer) == [
        {"distanceKey": "5k", "timeS": 1625.25, "achievedAt": "2026-09-13T06:00:00Z"},
        {"distanceKey": "marathon", "timeS": 15012.5, "achievedAt": "2026-09-13T06:00:00Z"},
    ]


def test_records_fall_back_to_pr_start_time_without_the_runs_start(
    make_client: AppFactory,
) -> None:
    answer = [record(1, 290.5, activityStartDateTimeInGMT=None), record(2, 480.0)]

    assert records_of(make_client, answer) == [
        {"distanceKey": "1k", "timeS": 290.5, "achievedAt": "2026-09-13T06:05:12Z"},
        {"distanceKey": "1mi", "timeS": 480.0, "achievedAt": "2026-09-13T06:00:00Z"},
    ]


def test_records_keep_milliseconds_of_the_start_as_iso_utc_with_z(
    make_client: AppFactory,
) -> None:
    answer = [record(4, 3500.0, activityStartDateTimeInGMT=1_789_279_200_123)]

    assert records_of(make_client, answer) == [
        {"distanceKey": "10k", "timeS": 3500.0, "achievedAt": "2026-09-13T06:00:00.123000Z"}
    ]


def test_records_skip_steps_longest_run_unknown_types_non_positive_values_and_no_date(
    make_client: AppFactory,
) -> None:
    answer = [
        record(7, 24012.6),
        record(12, 31234.0, activityId=0, activityStartDateTimeInGMT=None),
        record(99, 100.0),
        record(1, 0.0),
        record(2, -5.0),
        record(3, None),
        record(4, 3500.0, activityStartDateTimeInGMT=None, prStartTimeGmt=None),
        record(5, 7700.0),
    ]

    assert records_of(make_client, answer) == [
        {"distanceKey": "half", "timeS": 7700.0, "achievedAt": "2026-09-13T06:00:00Z"}
    ]


def test_records_keep_the_fastest_when_garmin_lists_a_distance_twice(
    make_client: AppFactory,
) -> None:
    answer = [record(3, 1710.0), record(3, 1690.0), record(3, 1700.0)]

    assert records_of(make_client, answer) == [
        {"distanceKey": "5k", "timeS": 1690.0, "achievedAt": "2026-09-13T06:00:00Z"}
    ]


@pytest.mark.parametrize("answer", [[], {}])
def test_records_are_empty_for_an_account_without_records(
    make_client: AppFactory, answer: Any
) -> None:
    assert records_of(make_client, answer) == []


@pytest.mark.parametrize(
    "answer", [{"records": [{"typeId": 3, "value": 1625.87}]}, "1625.87", 1625.87, True]
)
def test_unreadable_records_answer_gives_null_records_with_the_series_intact(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str], answer: Any
) -> None:
    garmin = ScriptedGarmin(personal_records=answer)

    body = fetch(make_client, [42], include_records=True, connect=garmin.connect())

    assert body["records"] is None
    assert outcomes(body) == ["ok"]
    assert len(body["series"][0]["elapsedS"]) == FIXTURE_ROWS
    logs = capsys.readouterr().out
    assert "unexpected personal records answer from Garmin, answered without them" in logs
    assert "1625.87" not in logs


def test_malformed_mapped_record_is_skipped_while_the_others_map_and_logs_fields_not_values(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = ScriptedGarmin(
        personal_records=[
            record(3, 1625.87),
            record(4, "54:41"),
            record(5, 7731.52, prStartTimeGmt="2026-09-13 06:05:12"),
            record(1, float("inf")),
            record(2, -471.93),
            record(6, 15012.5, activityStartDateTimeInGMT=None, prStartTimeGmt=None),
        ]
    )

    body = fetch(make_client, [], include_records=True, connect=garmin.connect())

    assert body["records"] == [
        {"distanceKey": "5k", "timeS": 1625.87, "achievedAt": "2026-09-13T06:00:00Z"}
    ]
    skipped = [
        line["fields"]
        for line in log_lines(capsys)
        if line["msg"] == "unreadable personal record from Garmin, skipped"
    ]
    assert skipped == [
        ["1.value"],
        ["2.prStartTimeGmt"],
        ["3.value"],
        ["4.value"],
        ["5.activityStartDateTimeInGMT", "5.prStartTimeGmt"],
    ]


def test_unmapped_malformed_records_are_ignored_without_a_warning(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = ScriptedGarmin(
        personal_records=[
            {"value": 1625.87},
            record(7, "a long way"),
            record(12, "lots of steps", activityId=0, activityStartDateTimeInGMT="never"),
            {**record(16, None), "value": {"goal": "met"}},
            {"typeId": "3", "value": 1500.0},
            {"typeId": True, "value": 200.0},
            {"typeId": None},
            "not an object",
            None,
            record(3, 1625.87),
        ]
    )

    body = fetch(make_client, [], include_records=True, connect=garmin.connect())

    assert body["records"] == [
        {"distanceKey": "5k", "timeS": 1625.87, "achievedAt": "2026-09-13T06:00:00Z"}
    ]
    assert "personal record" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "error",
    [
        not_found_error(),
        garmin_down_error(),
        blocked_error(),
        network_error(),
        ValueError("a library bug quoting 1625.87"),
    ],
)
def test_records_call_failing_gives_null_records_with_the_series_intact(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str], error: Exception
) -> None:
    garmin = ScriptedGarmin(records_error=error)

    body = fetch(make_client, [42], include_records=True, connect=garmin.connect())

    assert body["records"] is None
    assert outcomes(body) == ["ok"]
    assert len(body["series"][0]["elapsedS"]) == FIXTURE_ROWS
    warning = next(
        line
        for line in log_lines(capsys)
        if line["msg"] == "could not read Garmin's records, answered without them"
    )
    assert warning["error_chain"][0] == type(error).__name__
    assert "API Error" not in json.dumps(warning)
    assert "1625.87" not in json.dumps(warning)


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (rate_limited_error(), 429, "garmin_rate_limited"),
        (auth_failed_error(), 401, "garmin_auth_expired"),
    ],
)
def test_records_call_rate_limited_or_with_a_dead_login_fails_the_request_with_the_rotated_bundle(
    make_client: AppFactory, error: Exception, status: int, code: str
) -> None:
    garmin = ScriptedGarmin(records_error=error, rotate_to=rotated(bundle()))

    response = make_client(connect=garmin.connect()).post(
        PATH, json=series_body([42], include_records=True)
    )

    assert response.status_code == status
    assert response.json()["code"] == code
    assert response.json()["tokenBundle"] == rotated(bundle())


# Errors.


def test_returns_401_unauthorized_and_never_calls_garmin_when_the_secret_is_wrong(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(secret_header="nope", connect=garmin.connect()).post(
        PATH, json=series_body([OUTDOOR], include_records=True)
    )

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert garmin.calls == []


def test_expired_token_returns_401_garmin_auth_expired(make_client: AppFactory) -> None:
    response = make_client().post(
        PATH, json=series_body([OUTDOOR], token_bundle=bundle(fixture="expired"))
    )

    assert response.status_code == 401
    assert response.json()["code"] == "garmin_auth_expired"


def test_rate_limited_login_returns_429_with_retry_after(make_client: AppFactory) -> None:
    response = make_client().post(
        PATH, json=series_body([OUTDOOR], token_bundle=bundle(fixture="rate_limited"))
    )

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    assert response.json()["code"] == "garmin_rate_limited"
    assert response.json()["retryAfterSeconds"] == 3600


def test_garmin_down_at_login_returns_502_unavailable(make_client: AppFactory) -> None:
    response = make_client().post(
        PATH, json=series_body([OUTDOOR], token_bundle=bundle(fixture="unavailable"))
    )

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


@pytest.mark.parametrize(
    ("ids", "include_records"),
    [
        ([OUTDOOR], False),
        # No series asked: the records call is the first after login.
        ([], True),
    ],
)
def test_rate_limited_after_login_rotated_fails_the_request_with_the_rotated_bundle(
    make_client: AppFactory, ids: list[int], include_records: bool
) -> None:
    response = make_client().post(
        PATH,
        json=series_body(
            ids,
            include_records=include_records,
            token_bundle=bundle(fixture="rotate_then_rate_limited"),
        ),
    )

    assert response.status_code == 429
    assert response.json()["code"] == "garmin_rate_limited"
    assert json.loads(response.json()["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


def test_garmin_down_after_login_rotated_fails_the_run_and_returns_the_rotated_bundle(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        PATH,
        json=series_body([OUTDOOR, NO_HR], token_bundle=bundle(fixture="rotate_then_unavailable")),
    )

    assert response.status_code == 200
    assert outcomes(response.json()) == ["failed", "ok"]
    assert json.loads(response.json()["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


def test_garmin_down_on_the_records_call_after_login_rotated_gives_null_records(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        PATH,
        json=series_body(
            [], include_records=True, token_bundle=bundle(fixture="rotate_then_unavailable")
        ),
    )

    assert response.status_code == 200
    assert response.json()["records"] is None
    assert json.loads(response.json()["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


@pytest.mark.parametrize("failing_id", ["42", "7"])
def test_rate_limited_on_any_run_fails_the_request_with_429_the_rotated_bundle_and_no_further_call(
    make_client: AppFactory, failing_id: str
) -> None:
    garmin = ScriptedGarmin(
        details_errors={failing_id: rate_limited_error()}, rotate_to=rotated(bundle())
    )

    response = make_client(connect=garmin.connect()).post(
        PATH, json=series_body([42, 7, 8], include_records=True)
    )

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    assert response.json()["code"] == "garmin_rate_limited"
    assert response.json()["tokenBundle"] == rotated(bundle())
    assert garmin.calls[-1] == f"get_activity_details:{failing_id}:10000:0"


def test_expired_login_on_a_run_fails_the_request_with_401_and_the_rotated_bundle(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(details_errors={"7": auth_failed_error()}, rotate_to=rotated(bundle()))

    response = make_client(connect=garmin.connect()).post(
        PATH, json=series_body([42, 7, 8], include_records=True)
    )

    assert response.status_code == 401
    assert response.json()["code"] == "garmin_auth_expired"
    assert response.json()["tokenBundle"] == rotated(bundle())
    assert garmin.calls[-1] == "get_activity_details:7:10000:0"


def test_an_error_that_is_not_garmins_on_a_run_still_fails_the_request_with_500(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(details_errors={"7": RuntimeError("a bug")})

    response = make_client(connect=garmin.connect()).post(PATH, json=series_body([42, 7, 8]))

    assert response.status_code == 500
    assert response.json()["code"] == "internal"


@pytest.mark.parametrize("error", [garmin_down_error(), blocked_error(), network_error()])
def test_garmin_failing_one_run_fails_only_that_run_and_logs_the_code_not_the_message(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str], error: Exception
) -> None:
    garmin = ScriptedGarmin(details_errors={"7": error})

    body = fetch(make_client, [42, 7, 8], include_records=True, connect=garmin.connect())

    assert outcomes(body) == ["ok", "failed", "ok"]
    assert body["series"][1] == empty(7, "failed")
    assert len(body["series"][0]["elapsedS"]) == len(body["series"][2]["elapsedS"]) == FIXTURE_ROWS
    assert body["records"] == FIXTURE_RECORDS
    assert garmin.calls[1:] == [
        "get_activity_details:42:10000:0",
        "get_activity_details:7:10000:0",
        "get_activity_details:8:10000:0",
        "get_personal_record",
    ]
    warning = next(
        line
        for line in log_lines(capsys)
        if line["msg"] == "could not read one run's series, the batch goes on"
    )
    assert warning["code"] == "garmin_unavailable"
    assert warning["error_chain"] == [type(error).__name__, type(error.__cause__).__name__]
    assert "API Error" not in json.dumps(warning)
    assert "connection reset" not in json.dumps(warning)


def test_every_run_failing_still_answers_200_with_every_outcome_failed(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(details_errors={"1": garmin_down_error(), "2": blocked_error()})
    sent = bundle()

    response = make_client(connect=garmin.connect()).post(
        PATH, json=series_body([1, 2], token_bundle=sent)
    )

    assert response.status_code == 200
    assert response.json() == {
        "tokenBundle": sent,
        "series": [empty(1, "failed"), empty(2, "failed")],
        "records": None,
    }


def test_after_two_runs_fail_in_a_row_the_rest_are_skipped_without_a_call_and_records_are_null(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = ScriptedGarmin(details_errors={"2": garmin_down_error(), "3": network_error()})

    body = fetch(make_client, [1, 2, 3, 4, 5, 4], include_records=True, connect=garmin.connect())

    assert outcomes(body) == ["ok", "failed", "failed", "skipped", "skipped", "skipped"]
    assert body["series"][3] == empty(4, "skipped")
    assert body["records"] is None
    assert garmin.calls == [
        "login",
        "get_activity_details:1:10000:0",
        "get_activity_details:2:10000:0",
        "get_activity_details:3:10000:0",
    ]
    fetched = next(line for line in log_lines(capsys) if line["msg"] == "activity series fetched")
    assert (fetched["ok"], fetched["failed"], fetched["skipped"]) == (1, 2, 2)


def test_on_the_fixture_account_two_unavailable_runs_in_a_row_skip_the_runs_after_them(
    make_client: AppFactory,
) -> None:
    body = fetch(
        make_client, [OUTDOOR, UNAVAILABLE, UNAVAILABLE_TOO, VIRTUAL, MANUAL], include_records=True
    )

    assert outcomes(body) == ["ok", "failed", "failed", "skipped", "skipped"]
    assert body["series"][3:] == [empty(VIRTUAL, "skipped"), empty(MANUAL, "skipped")]
    assert len(body["series"][0]["elapsedS"]) == FIXTURE_ROWS
    assert body["records"] is None


def test_a_run_that_works_between_failures_resets_the_failures_in_a_row(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(details_errors={"1": garmin_down_error(), "3": garmin_down_error()})

    body = fetch(make_client, [1, 2, 3, 4], include_records=True, connect=garmin.connect())

    assert outcomes(body) == ["failed", "ok", "failed", "ok"]
    assert body["records"] == FIXTURE_RECORDS
    assert garmin.calls[-1] == "get_personal_record"


def test_past_the_time_budget_no_call_starts_and_every_run_left_is_skipped(
    make_client: AppFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(activity_series, "SERIES_BUDGET_S", 0.0)
    garmin = ScriptedGarmin()

    body = fetch(make_client, [42, 7], include_records=True, connect=garmin.connect())

    assert body["series"] == [empty(42, "skipped"), empty(7, "skipped")]
    assert body["records"] is None
    assert garmin.calls == ["login"]


@pytest.mark.parametrize(
    "body",
    [
        series_body(list(range(1, 12))),
        series_body([0]),
        series_body([-1]),
        series_body([1.5]),
        series_body(["1"]),
        series_body([True]),
        series_body([2**53]),
        series_body([1], include_records="true"),
        {"tokenBundle": bundle(), "garminActivityIds": [1]},
        {**series_body([1]), "maxChart": 10_000},
        {"garminActivityIds": [1], "includeRecords": False},
    ],
)
def test_returns_400_validation_for_a_bad_body_and_never_calls_garmin(
    make_client: AppFactory, body: dict[str, Any]
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(connect=garmin.connect()).post(PATH, json=body)

    assert response.status_code == 400
    assert response.json()["code"] == "validation"
    assert "tokenBundle" not in response.json()
    assert garmin.calls == []


def test_accepts_ten_ids_the_batch_maximum(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin()

    series = fetch(make_client, list(range(1, 11)), connect=garmin.connect())["series"]

    assert [s["garminActivityId"] for s in series] == list(range(1, 11))
    assert len(garmin.calls) == 11
