"""POST /activities/{id}/detail through the real app, with the fixture fake or a scripted Garmin.

Fixture values: detail-splits.json has 17 laps, detail-series.json 551 rows, detail-hr-zones.json
five zones, all from one sanitized run.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from garminconnect import GarminConnectNotFoundError, GarminConnectTooManyRequestsError

from tests.conftest import AppFactory
from tests.helpers import BASE_BUNDLE, ScriptedGarmin, bundle, read_fixture, rotated

OUTDOOR = 10_000_000_007
TREADMILL = 10_000_000_006
NO_HR = 10_000_000_004
MANUAL = 10_000_000_003
HR_ZERO = 9_000_000_035
VIRTUAL = 9_000_000_023
UNKNOWN = 12_345
FIXTURE_LAPS = 17
FIXTURE_ROWS = 551
FIXTURE_ZONES = [
    {"zone": 1, "lowBpm": 98.0, "seconds": 0.0},
    {"zone": 2, "lowBpm": 118.0, "seconds": 33.233},
    {"zone": 3, "lowBpm": 137.0, "seconds": 113.162},
    {"zone": 4, "lowBpm": 157.0, "seconds": 6173.86},
    {"zone": 5, "lowBpm": 176.0, "seconds": 216.989},
]
EMPTY_STREAMS: dict[str, Any] = {
    "elapsedS": [],
    "distanceM": [],
    "hr": None,
    "cadence": None,
    "elevationM": None,
    "speedMps": None,
}


def path(activity_id: int | str) -> str:
    return f"/activities/{activity_id}/detail"


def detail_body(**overrides: str) -> dict[str, str]:
    return {"tokenBundle": bundle(), **overrides}


def fetch(make_client: AppFactory, activity_id: int = OUTDOOR, **kwargs: Any) -> dict[str, Any]:
    response = make_client(**kwargs).post(path(activity_id), json=detail_body())
    assert response.status_code == 200, response.json()
    detail: dict[str, Any] = response.json()["detail"]
    return detail


def raw_details(
    keys: list[str],
    rows: list[list[float | None]],
    polyline: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """get_activity_details' shape: one descriptor per key, in column order."""
    details: dict[str, Any] = {
        "activityId": 42,
        "metricDescriptors": [
            {"metricsIndex": i, "key": key, "unit": {"id": 1, "key": "unit", "factor": 1.0}}
            for i, key in enumerate(keys)
        ],
        "activityDetailMetrics": [{"metrics": row} for row in rows],
        "detailsAvailable": True,
    }
    if polyline is not None:
        details["geoPolylineDTO"] = {"polyline": polyline}
    return details


# Success on the fixture run.


def test_returns_the_fixture_laps_in_si_with_the_unchanged_bundle(make_client: AppFactory) -> None:
    sent = bundle()
    response = make_client().post(path(OUTDOOR), json=detail_body(tokenBundle=sent))

    assert response.status_code == 200
    body = response.json()
    assert body["tokenBundle"] == sent
    laps = body["detail"]["laps"]
    assert len(laps) == FIXTURE_LAPS
    assert [lap["index"] for lap in laps] == list(range(1, FIXTURE_LAPS + 1))
    assert laps[0] == {
        "index": 1,
        "distanceM": 1000.0,
        "durationS": 390.422,
        "avgHr": 167.0,
        "avgCadence": 145.515625,
    }
    assert laps[-1] == {
        "index": 17,
        "distanceM": 674.76,
        "durationS": 313.685,
        "avgHr": 159.0,
        "avgCadence": 129.125,
    }


def test_returns_the_fixture_series_row_aligned_with_double_cadence(
    make_client: AppFactory,
) -> None:
    streams = fetch(make_client)["streams"]

    assert {len(values) for values in streams.values()} == {FIXTURE_ROWS}
    first_rows = {key: values[:2] for key, values in streams.items()}
    assert first_rows == {
        "elapsedS": [0.0, 8.0],
        "distanceM": [1.9600000381469727, 24.15999984741211],
        "hr": [150.0, 145.0],
        # directDoubleCadence (both feet), not directRunCadence's 54 and 75.
        "cadence": [108.0, 150.0],
        "elevationM": [314.0, 314.0],
        "speedMps": [1.437000036239624, 2.369999885559082],
    }
    assert streams["elapsedS"][-1] == 6532.0
    assert streams["distanceM"][-1] == 16666.970703125
    assert streams["elapsedS"] == sorted(streams["elapsedS"])


def test_returns_the_fixture_hr_zones_in_order(make_client: AppFactory) -> None:
    assert fetch(make_client)["hrZones"] == FIXTURE_ZONES


def test_returns_the_fakes_fictional_loop_as_the_route_of_an_outdoor_run(
    make_client: AppFactory,
) -> None:
    route = fetch(make_client)["route"]

    assert len(route) == 121
    assert route[0] == route[-1]
    assert all(abs(lat) <= 0.02 and abs(lon + 30.0) <= 0.02 for lat, lon in route)


def test_asks_garmin_for_splits_details_and_zones_of_the_id_in_that_order(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(connect=garmin.connect()).post(path(42), json=detail_body())

    assert response.status_code == 200
    assert garmin.calls == [
        "login",
        "get_activity_splits:42",
        "get_activity_details:42:2000:4000",
        "get_activity_hr_in_timezones:42",
    ]


def test_returns_the_rotated_bundle_with_the_detail(make_client: AppFactory) -> None:
    response = make_client().post(
        path(OUTDOOR), json=detail_body(tokenBundle=bundle(fixture="rotate"))
    )

    assert response.status_code == 200
    body = response.json()
    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}
    assert len(body["detail"]["laps"]) == FIXTURE_LAPS


# Variants the fake derives from the account's list item.


@pytest.mark.parametrize("activity_id", [TREADMILL, VIRTUAL])
def test_indoor_run_has_no_route_and_no_elevation_but_keeps_hr_and_cadence(
    make_client: AppFactory, activity_id: int
) -> None:
    detail = fetch(make_client, activity_id)

    assert detail["route"] is None
    assert detail["streams"]["elevationM"] is None
    assert detail["streams"]["hr"][:2] == [150.0, 145.0]
    assert detail["streams"]["cadence"][:2] == [108.0, 150.0]
    assert detail["streams"]["speedMps"][:2] == [1.437000036239624, 2.369999885559082]
    assert detail["hrZones"] == FIXTURE_ZONES


@pytest.mark.parametrize("activity_id", [NO_HR, HR_ZERO])
def test_run_without_hr_has_no_hr_series_no_lap_hr_and_no_zones(
    make_client: AppFactory, activity_id: int
) -> None:
    detail = fetch(make_client, activity_id)

    assert detail["streams"]["hr"] is None
    assert detail["hrZones"] is None
    assert {lap["avgHr"] for lap in detail["laps"]} == {None}
    assert detail["laps"][0]["avgCadence"] == 145.515625
    assert detail["streams"]["cadence"][:2] == [108.0, 150.0]
    assert len(detail["streams"]["elapsedS"]) == FIXTURE_ROWS


def test_manual_entry_has_no_laps_no_samples_no_route_and_no_zones(
    make_client: AppFactory,
) -> None:
    assert fetch(make_client, MANUAL) == {
        "laps": [],
        "streams": EMPTY_STREAMS,
        "route": None,
        "hrZones": None,
    }


# Errors.


def test_unknown_id_returns_404_not_found(make_client: AppFactory) -> None:
    response = make_client().post(path(UNKNOWN), json=detail_body())

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "not_found"
    assert "tokenBundle" not in response.json()


def test_unknown_id_after_login_rotated_returns_404_with_the_rotated_bundle(
    make_client: AppFactory,
) -> None:
    sent = bundle()
    not_found = GarminConnectNotFoundError("API call client error (404): API Error 404")
    not_found.__cause__ = GarminConnectNotFoundError("API Error 404")
    garmin = ScriptedGarmin(rotate_to=rotated(sent), detail_error=not_found)

    response = make_client(connect=garmin.connect()).post(
        path(UNKNOWN), json=detail_body(tokenBundle=sent)
    )

    assert response.status_code == 404
    assert response.json()["code"] == "not_found"
    assert response.json()["tokenBundle"] == rotated(sent)


@pytest.mark.parametrize("activity_id", ["0", "-1", "abc", "1.5", str(2**53)])
def test_returns_400_validation_for_an_id_that_is_not_a_positive_safe_integer(
    make_client: AppFactory, activity_id: str
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(connect=garmin.connect()).post(path(activity_id), json=detail_body())

    assert response.status_code == 400
    assert response.json()["code"] == "validation"
    assert garmin.calls == []


@pytest.mark.parametrize(
    "body", [{}, {"tokenBundle": "x"}, {"tokenBundle": bundle(), "activityId": 1}]
)
def test_returns_400_validation_for_a_bad_body(
    make_client: AppFactory, body: dict[str, Any]
) -> None:
    response = make_client().post(path(OUTDOOR), json=body)

    assert response.status_code == 400
    assert response.json()["code"] == "validation"


def test_returns_401_unauthorized_and_never_calls_garmin_when_the_secret_is_wrong(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(secret_header="nope", connect=garmin.connect()).post(
        path(OUTDOOR), json=detail_body()
    )

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert garmin.calls == []


def test_returns_401_garmin_auth_expired_when_the_bundle_is_expired(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        path(OUTDOOR), json=detail_body(tokenBundle=bundle(fixture="expired"))
    )

    assert response.status_code == 401
    assert response.json()["code"] == "garmin_auth_expired"


def test_returns_429_with_retry_after_when_garmin_rate_limits_the_login(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        path(OUTDOOR), json=detail_body(tokenBundle=bundle(fixture="rate_limited"))
    )

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    assert response.json()["code"] == "garmin_rate_limited"
    assert response.json()["retryAfterSeconds"] == 3600


def test_returns_429_and_makes_no_further_call_when_a_detail_call_is_rate_limited(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        detail_error=GarminConnectTooManyRequestsError("Rate limit exceeded: API Error 429")
    )

    response = make_client(connect=garmin.connect()).post(path(OUTDOOR), json=detail_body())

    assert response.status_code == 429
    assert response.json()["code"] == "garmin_rate_limited"
    assert garmin.calls == ["login", f"get_activity_splits:{OUTDOOR}"]


def test_returns_502_garmin_unavailable_when_garmin_is_down(make_client: AppFactory) -> None:
    response = make_client().post(
        path(OUTDOOR), json=detail_body(tokenBundle=bundle(fixture="unavailable"))
    )

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


@pytest.mark.parametrize(
    ("behaviour", "status", "code"),
    [
        ("rotate_then_rate_limited", 429, "garmin_rate_limited"),
        ("rotate_then_unavailable", 502, "garmin_unavailable"),
    ],
)
def test_returns_the_rotated_bundle_when_a_detail_call_fails_after_login_rotated_the_tokens(
    make_client: AppFactory, behaviour: str, status: int, code: str
) -> None:
    response = make_client().post(
        path(OUTDOOR), json=detail_body(tokenBundle=bundle(fixture=behaviour))
    )

    assert response.status_code == status
    assert response.json()["code"] == code
    assert json.loads(response.json()["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


def test_returns_502_and_logs_no_values_when_garmin_changes_the_detail_shape(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    splits = read_fixture("detail-splits.json")
    splits["lapDTOs"][0]["distance"] = "390.422 m"
    garmin = ScriptedGarmin(splits=splits)

    response = make_client(connect=garmin.connect()).post(path(OUTDOOR), json=detail_body())

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"
    logs = capsys.readouterr().out
    assert "lapDTOs.0.distance" in logs
    assert "390.422" not in logs


# Mapping, on scripted answers.

SERIES_KEYS = ["sumDuration", "sumDistance", "directHeartRate", "directSpeed"]


def streams_of(make_client: AppFactory, details: dict[str, Any]) -> dict[str, Any]:
    garmin = ScriptedGarmin(details=details)
    streams: dict[str, Any] = fetch(make_client, connect=garmin.connect())["streams"]
    return streams


def test_drops_rows_whose_sum_duration_or_sum_distance_is_none_and_keeps_other_nulls(
    make_client: AppFactory,
) -> None:
    details = raw_details(
        SERIES_KEYS,
        [
            [0.0, 0.0, 140.0, 0.0],
            [None, 5.0, 141.0, 2.5],
            [2.0, None, 142.0, 2.5],
            [3.0, 8.0, None, None],
            [4.0, 11.0, 144.0, 3.0],
        ],
    )

    assert streams_of(make_client, details) == {
        "elapsedS": [0.0, 3.0, 4.0],
        "distanceM": [0.0, 8.0, 11.0],
        "hr": [140.0, None, 144.0],
        "cadence": None,
        "elevationM": None,
        "speedMps": [0.0, None, 3.0],
    }


def test_chooses_direct_double_cadence_over_direct_run_cadence_whatever_the_column_order(
    make_client: AppFactory,
) -> None:
    details = raw_details(
        ["directRunCadence", "sumDistance", "directDoubleCadence", "sumDuration"],
        [[80.0, 0.0, 160.0, 0.0], [81.0, 3.0, 162.0, 1.0]],
    )

    assert streams_of(make_client, details)["cadence"] == [160.0, 162.0]


def test_a_series_is_null_when_its_descriptor_is_absent_or_every_value_is_none(
    make_client: AppFactory,
) -> None:
    details = raw_details(
        [*SERIES_KEYS, "directElevation"],
        [[0.0, 0.0, None, 1.0, -2.5], [1.0, 3.0, None, 2.0, None]],
    )

    streams = streams_of(make_client, details)

    assert streams["hr"] is None
    assert streams["cadence"] is None
    # Below sea level is an elevation; a missing sample stays a null element.
    assert streams["elevationM"] == [-2.5, None]


def test_reports_zero_bpm_samples_as_missing_and_a_series_of_zeros_as_no_hr(
    make_client: AppFactory,
) -> None:
    some_zero = raw_details(SERIES_KEYS, [[0.0, 0.0, 0.0, 1.0], [1.0, 3.0, 150.0, 2.0]])
    all_zero = raw_details(SERIES_KEYS, [[0.0, 0.0, 0.0, 1.0], [1.0, 3.0, 0.0, 2.0]])

    assert streams_of(make_client, some_zero)["hr"] == [None, 150.0]
    assert streams_of(make_client, all_zero)["hr"] is None


@pytest.mark.parametrize(
    "details",
    [
        {**raw_details(SERIES_KEYS, [[0.0, 0.0, 140.0, 1.0]]), "detailsAvailable": False},
        raw_details(SERIES_KEYS, []),
        raw_details(["sumDistance", "directHeartRate"], [[0.0, 140.0]]),
        raw_details(SERIES_KEYS, [[None, 0.0, 140.0, 1.0]]),
        # What the library returns when Garmin answers 204 No Content.
        {},
    ],
)
def test_streams_are_empty_without_usable_rows(
    make_client: AppFactory, details: dict[str, Any]
) -> None:
    assert streams_of(make_client, details) == EMPTY_STREAMS


def test_maps_the_polyline_to_lat_lon_pairs_in_order_skipping_points_without_both(
    make_client: AppFactory,
) -> None:
    # Fictional coordinates in open ocean.
    polyline: list[dict[str, Any]] = [
        {"lat": 0.001, "lon": -30.001, "altitude": 3.0, "time": 1, "valid": True},
        {"lat": None, "lon": -30.002, "valid": False},
        {"lat": 0.003, "lon": None, "valid": False},
        {"lat": 0.004, "lon": -30.004, "valid": True},
        {"lon": -30.005},
        {"lat": -0.005, "lon": -29.995, "valid": True},
    ]
    garmin = ScriptedGarmin(details=raw_details(SERIES_KEYS, [], polyline))

    route = fetch(make_client, connect=garmin.connect())["route"]

    assert route == [[0.001, -30.001], [0.004, -30.004], [-0.005, -29.995]]


@pytest.mark.parametrize(
    "geo",
    [None, {"polyline": []}, {"polyline": None}, {"polyline": [{"lat": None, "lon": None}]}],
)
def test_route_is_null_without_a_track(make_client: AppFactory, geo: Any) -> None:
    details = {**raw_details(SERIES_KEYS, []), "geoPolylineDTO": geo}
    garmin = ScriptedGarmin(details=details)

    assert fetch(make_client, connect=garmin.connect())["route"] is None


def test_lap_index_falls_back_to_the_position_and_zero_hr_or_cadence_is_missing(
    make_client: AppFactory,
) -> None:
    splits = {
        "lapDTOs": [
            {"lapIndex": 1, "distance": 1000.0, "duration": 300.0, "averageHR": 0.0},
            {"distance": 500.0, "duration": 160.0, "averageRunCadence": 0},
        ]
    }
    garmin = ScriptedGarmin(splits=splits)

    laps = fetch(make_client, connect=garmin.connect())["laps"]

    assert laps == [
        {"index": 1, "distanceM": 1000.0, "durationS": 300.0, "avgHr": None, "avgCadence": None},
        {"index": 2, "distanceM": 500.0, "durationS": 160.0, "avgHr": None, "avgCadence": None},
    ]


@pytest.mark.parametrize("splits", [{}, {"activityId": 42, "lapDTOs": None}, {"lapDTOs": []}])
def test_laps_are_empty_when_garmin_has_none(
    make_client: AppFactory, splits: dict[str, Any]
) -> None:
    garmin = ScriptedGarmin(splits=splits)

    assert fetch(make_client, connect=garmin.connect())["laps"] == []


def test_orders_zones_by_number_and_ignores_numbers_outside_one_to_five(
    make_client: AppFactory,
) -> None:
    zones = [
        {"zoneNumber": 3, "secsInZone": 30.0, "zoneLowBoundary": 137},
        {"zoneNumber": 1, "secsInZone": 10.0, "zoneLowBoundary": 98},
        {"zoneNumber": 6, "secsInZone": 99.0, "zoneLowBoundary": 190},
        {"zoneNumber": 2, "secsInZone": None, "zoneLowBoundary": 118},
    ]
    garmin = ScriptedGarmin(hr_zones=zones)

    assert fetch(make_client, connect=garmin.connect())["hrZones"] == [
        {"zone": 1, "lowBpm": 98.0, "seconds": 10.0},
        {"zone": 2, "lowBpm": 118.0, "seconds": 0.0},
        {"zone": 3, "lowBpm": 137.0, "seconds": 30.0},
    ]


@pytest.mark.parametrize(
    "zones",
    [
        [],
        {},
        [{**zone, "secsInZone": 0.0} for zone in read_fixture("detail-hr-zones.json")],
    ],
)
def test_hr_zones_are_null_when_no_zone_holds_a_second(make_client: AppFactory, zones: Any) -> None:
    garmin = ScriptedGarmin(hr_zones=zones)

    assert fetch(make_client, connect=garmin.connect())["hrZones"] is None
