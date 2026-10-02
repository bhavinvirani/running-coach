"""Garmin's full-rate samples of a run as timer and distance series, and Garmin's own running
records, for best efforts and personal bests."""

import logging
from datetime import UTC, datetime, timedelta

from garminconnect import GarminConnectConnectionError
from pydantic import TypeAdapter, ValidationError

from garmin_service.activity_detail import parse_details, timed_rows
from garmin_service.client import GarminSession
from garmin_service.errors import from_garmin_exception, unavailable
from garmin_service.models.garmin import GarminPersonalRecord
from garmin_service.models.problem import ErrorCode
from garmin_service.models.series import DISTANCE_KEYS, ActivitySeries, DistanceKey, GarminRecord

log = logging.getLogger(__name__)

# Garmin's own rate, one row a second: a 1:57 run came back as 7,028 rows at this size and as
# 1,770 thinned rows at the detail route's 2000, too coarse for a best effort to the second.
SERIES_MAX_CHART = 10_000
# No polyline: best efforts need no route, and the answer stays smaller.
SERIES_MAX_POLY = 0

# get_personal_record's typeId of each running record at a distance the app knows; `value` is
# seconds. 1 to 5 were seen on the owner's account (2026-10-02); 6 as the marathon is assumed from
# the library's docstring, since no marathon was recorded. 7 (longest run, in meters) and the step
# and goal records (12 to 16) are ignored.
GARMIN_RECORD_DISTANCES: dict[int, DistanceKey] = {
    1: "1k",
    2: "1mi",
    3: "5k",
    4: "10k",
    5: "half",
    6: "marathon",
}

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_RECORDS = TypeAdapter(list[GarminPersonalRecord])


def details_or_none(garmin: GarminSession, garmin_activity_id: int) -> object | None:
    """get_activity_details at full rate; None when Garmin no longer has the run.

    A run deleted on Garmin has no best efforts, and it must not fail the other runs of the batch.
    Every other failure fails the request through errors.py, which also decides what is a 404.
    """
    try:
        return garmin.call(
            garmin.api.get_activity_details,
            str(garmin_activity_id),
            maxchart=SERIES_MAX_CHART,
            maxpoly=SERIES_MAX_POLY,
        )
    except GarminConnectConnectionError as exc:
        error = from_garmin_exception(exc)
        if error is None or error.code is not ErrorCode.NOT_FOUND:
            raise
        return None


def to_series(garmin_activity_id: int, details: object | None) -> ActivitySeries:
    elapsed_s: list[float] = []
    distance_m: list[float] = []
    rows = [] if details is None else timed_rows(parse_details(details))
    for elapsed, distance, _ in rows:
        # The contract promises non-decreasing time, which a sliding window relies on.
        if elapsed_s and elapsed < elapsed_s[-1]:
            continue
        elapsed_s.append(elapsed)
        distance_m.append(distance)
    return ActivitySeries(
        garmin_activity_id=garmin_activity_id, elapsed_s=elapsed_s, distance_m=distance_m
    )


def to_records(raw: object) -> list[GarminRecord]:
    """Garmin's running records at the app's distances, shortest first, the fastest per distance.

    A record without a positive time or without any date says nothing comparable and is skipped.
    """
    fastest: dict[DistanceKey, GarminRecord] = {}
    for record in _parse_records(raw):
        distance_key = GARMIN_RECORD_DISTANCES.get(record.type_id)
        achieved_ms = record.activity_start_date_time_in_gmt or record.pr_start_time_gmt
        if distance_key is None or record.value is None or record.value <= 0 or not achieved_ms:
            continue
        mapped = GarminRecord(
            distance_key=distance_key,
            time_s=record.value,
            achieved_at=_EPOCH + timedelta(milliseconds=achieved_ms),
        )
        current = fastest.get(distance_key)
        if current is None or mapped.time_s < current.time_s:
            fastest[distance_key] = mapped
    return [fastest[key] for key in DISTANCE_KEYS if key in fastest]


def _parse_records(raw: object) -> list[GarminPersonalRecord]:
    # The library answers {} when Garmin sends 204 No Content: an account without records.
    if raw is None or raw == {}:
        return []
    try:
        return _RECORDS.validate_python(raw)
    except ValidationError as exc:
        # Where the shape broke, never the values: they are the runner's data.
        fields = [".".join(str(part) for part in error["loc"]) for error in exc.errors()]
        log.warning("unexpected personal records shape from Garmin", extra={"fields": fields})
        raise unavailable() from None
