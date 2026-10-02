"""POST /activities/series through the real app, with the fixture fake or a scripted Garmin.

Fixture values: detail-series.json has 551 rows of one sanitized run (16.67 km in 6532 timer
seconds); personal-records.json is made up in the captured shape, with the distance records 1 to 5,
the longest run 7 and the step and goal records 12 to 16.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from garminconnect import (
    GarminConnectConnectionError,
    GarminConnectNotFoundError,
    GarminConnectTooManyRequestsError,
)

from garmin_service.fake_client import FakeGarmin
from tests.conftest import AppFactory
from tests.helpers import BASE_BUNDLE, ScriptedGarmin, bundle, rotated

PATH = "/activities/series"
OUTDOOR = 10_000_000_007
TREADMILL = 10_000_000_006
NO_HR = 10_000_000_004
MANUAL = 10_000_000_003
VIRTUAL = 9_000_000_023
UNKNOWN = 12_345
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


def raw_details(rows: list[list[float | None]], keys: list[str] = SERIES_KEYS) -> dict[str, Any]:
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


def not_found_error() -> Exception:
    error = GarminConnectNotFoundError("API call client error (404): API Error 404")
    error.__cause__ = GarminConnectNotFoundError("API Error 404")
    return error


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
    for series in body["series"]:
        assert len(series["elapsedS"]) == len(series["distanceM"]) == FIXTURE_ROWS
        assert series["elapsedS"][:2] == FIRST_ELAPSED
        assert series["distanceM"][:2] == FIRST_DISTANCE
        assert (series["elapsedS"][-1], series["distanceM"][-1]) == (LAST_ELAPSED, LAST_DISTANCE)
        assert series["elapsedS"] == sorted(series["elapsedS"])


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


def test_deleted_run_an_id_outside_the_account_gives_empty_series_while_the_others_succeed(
    make_client: AppFactory,
) -> None:
    series = fetch(make_client, [OUTDOOR, UNKNOWN, VIRTUAL])["series"]

    assert [s["garminActivityId"] for s in series] == [OUTDOOR, UNKNOWN, VIRTUAL]
    assert series[1] == {"garminActivityId": UNKNOWN, "elapsedS": [], "distanceM": []}
    assert len(series[0]["elapsedS"]) == len(series[2]["elapsedS"]) == FIXTURE_ROWS


def test_deleted_run_after_login_rotated_still_returns_the_rotated_bundle(
    make_client: AppFactory,
) -> None:
    sent = bundle(fixture="rotate")
    response = make_client().post(PATH, json=series_body([UNKNOWN], token_bundle=sent))

    assert response.status_code == 200
    assert response.json()["tokenBundle"] == rotated(bundle())
    assert response.json()["series"] == [
        {"garminActivityId": UNKNOWN, "elapsedS": [], "distanceM": []}
    ]


def test_deleted_run_on_scripted_garmin_continues_to_the_next_id_and_the_records(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(details_errors={"5": not_found_error()})

    body = fetch(make_client, [5, 6], include_records=True, connect=garmin.connect())

    assert garmin.calls[-2:] == ["get_activity_details:6:10000:0", "get_personal_record"]
    assert body["series"][0] == {"garminActivityId": 5, "elapsedS": [], "distanceM": []}
    assert len(body["series"][1]["elapsedS"]) == FIXTURE_ROWS
    assert body["records"] == FIXTURE_RECORDS


def test_manual_entry_gives_empty_series(make_client: AppFactory) -> None:
    series = fetch(make_client, [MANUAL])["series"]

    assert series == [{"garminActivityId": MANUAL, "elapsedS": [], "distanceM": []}]


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


def test_logs_counts_only_never_series_or_record_values(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    fetch(make_client, [OUTDOOR, UNKNOWN], include_records=True)

    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]
    fetched = next(line for line in lines if line["msg"] == "activity series fetched")
    assert {key: fetched[key] for key in ("runs", "not_found", "rows", "records")} == {
        "runs": 2,
        "not_found": 1,
        "rows": FIXTURE_ROWS,
        "records": len(FIXTURE_RECORDS),
    }
    text = json.dumps(lines)
    for value in ("16666.97", "6532", "1702.36", "fixture-token"):
        assert value not in text


# Mapping the samples, on scripted answers.


def test_drops_rows_missing_time_or_distance_and_rows_that_go_back_in_time(
    make_client: AppFactory,
) -> None:
    details = raw_details(
        [
            [0.0, 0.0, 140.0],
            [None, 3.0, 141.0],
            [2.0, None, 142.0],
            [3.0, 8.0, None],
            [2.5, 9.0, 143.0],
            [4.0, 11.0, 144.0],
        ]
    )
    garmin = ScriptedGarmin(details=details)

    series = fetch(make_client, [42], connect=garmin.connect())["series"]

    assert series == [
        {"garminActivityId": 42, "elapsedS": [0.0, 3.0, 4.0], "distanceM": [0.0, 8.0, 11.0]}
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
def test_series_are_empty_without_usable_rows(
    make_client: AppFactory, details: dict[str, Any]
) -> None:
    garmin = ScriptedGarmin(details=details)

    series = fetch(make_client, [42], connect=garmin.connect())["series"]

    assert series == [{"garminActivityId": 42, "elapsedS": [], "distanceM": []}]


def test_unexpected_details_shape_returns_502_unavailable(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin(details={"activityDetailMetrics": "7028 rows"})

    response = make_client(connect=garmin.connect()).post(PATH, json=series_body([42]))

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


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
    ("answer", "field"),
    [
        ({"records": [{"typeId": 3, "value": 1625.87}]}, '"fields": [""]'),
        ([{"value": 1625.87}], "0.typeId"),
        ([record(3, 1625.87), record(4, "54:41")], "1.value"),
        ([record(3, 1625.87, prStartTimeGmt="2026-09-13 06:05:12")], "0.prStartTimeGmt"),
    ],
)
def test_unexpected_records_shape_returns_502_unavailable_and_logs_fields_not_values(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str], answer: Any, field: str
) -> None:
    garmin = ScriptedGarmin(personal_records=answer)

    response = make_client(connect=garmin.connect()).post(
        PATH, json=series_body([42], include_records=True)
    )

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"
    logs = capsys.readouterr().out
    assert "unexpected personal records shape from Garmin" in logs
    assert field in logs
    for value in ("1625.87", "54:41", "06:05:12"):
        assert value not in logs


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
    ("behaviour", "ids", "include_records", "status", "code"),
    [
        ("rotate_then_rate_limited", [OUTDOOR], False, 429, "garmin_rate_limited"),
        ("rotate_then_unavailable", [OUTDOOR], False, 502, "garmin_unavailable"),
        # No series asked: the records call is the first after login.
        ("rotate_then_rate_limited", [], True, 429, "garmin_rate_limited"),
    ],
)
def test_a_failed_call_after_login_rotated_returns_the_rotated_bundle(
    make_client: AppFactory,
    behaviour: str,
    ids: list[int],
    include_records: bool,
    status: int,
    code: str,
) -> None:
    response = make_client().post(
        PATH,
        json=series_body(
            ids, include_records=include_records, token_bundle=bundle(fixture=behaviour)
        ),
    )

    assert response.status_code == status
    assert response.json()["code"] == code
    assert json.loads(response.json()["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


def test_rate_limited_on_the_second_run_fails_the_batch_and_makes_no_further_call(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        details_errors={
            "7": GarminConnectTooManyRequestsError("Rate limit exceeded: API Error 429")
        }
    )

    response = make_client(connect=garmin.connect()).post(
        PATH, json=series_body([42, 7, 8], include_records=True)
    )

    assert response.status_code == 429
    assert response.json()["code"] == "garmin_rate_limited"
    assert garmin.calls == [
        "login",
        "get_activity_details:42:10000:0",
        "get_activity_details:7:10000:0",
    ]


def test_garmin_down_on_one_run_fails_the_batch_instead_of_an_empty_series(
    make_client: AppFactory,
) -> None:
    down = GarminConnectConnectionError("API call HTTP error")
    down.__cause__ = GarminConnectConnectionError("API Error 503")
    garmin = ScriptedGarmin(details_errors={"7": down})

    response = make_client(connect=garmin.connect()).post(PATH, json=series_body([42, 7]))

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


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
