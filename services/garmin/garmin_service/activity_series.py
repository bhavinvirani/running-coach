"""Garmin's full-rate samples of a run as timer and distance series, and Garmin's own running
records, for best efforts and personal bests.

A batch fails as a whole only on a 429 or a dead login: every later call would fail the same way,
and the API must back off or ask the runner to reconnect. Any other Garmin failure concerns one run
(its outcome says what became of it) or the records (null), and the batch goes on. An exception
that is not Garmin's is a bug here or in the library, and fails the request with a 500.
"""

import logging
import math
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError

from garmin_service.activity_detail import parse_details, timed_rows
from garmin_service.client import GarminSession
from garmin_service.errors import ServiceError, error_names, from_garmin_exception
from garmin_service.models.garmin import GarminPersonalRecord
from garmin_service.models.problem import ErrorCode
from garmin_service.models.series import (
    DISTANCE_KEYS,
    ActivitySeries,
    DistanceKey,
    GarminRecord,
    SeriesOutcome,
)

log = logging.getLogger(__name__)

# Garmin's own rate, one row a second: a 1:57 run came back as 7,028 rows at this size and as
# 1,770 thinned rows at the detail route's 2000, too coarse for a best effort to the second.
SERIES_MAX_CHART = 10_000
# No polyline: best efforts need no route, and the answer stays smaller.
SERIES_MAX_POLY = 0

# get_personal_record's typeId of each running record at a distance the app knows; `value` is
# seconds. 1 to 5 were seen on the owner's account (2026-10-02); 6 as the marathon is assumed from
# the library's docstring, since no marathon was recorded. 7 (longest run, in meters) and the step
# and goal records (12 to 16) are never read.
GARMIN_RECORD_DISTANCES: dict[int, DistanceKey] = {
    1: "1k",
    2: "1mi",
    3: "5k",
    4: "10k",
    5: "half",
    6: "marathon",
}

# The failures that end the whole request (errors.py answers them, with a rotated bundle).
REQUEST_FAILURES = frozenset({ErrorCode.GARMIN_RATE_LIMITED, ErrorCode.GARMIN_AUTH_EXPIRED})

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def empty_series(garmin_activity_id: int, outcome: SeriesOutcome) -> ActivitySeries:
    return ActivitySeries(
        garmin_activity_id=garmin_activity_id, outcome=outcome, elapsed_s=[], distance_m=[]
    )


def fetch_series(garmin: GarminSession, garmin_activity_id: int) -> ActivitySeries:
    """One run's samples at full rate: "ok", "gone" on a 404 (deleted on Garmin), or "failed" when
    this run alone could not be read. A 429, a dead login or an exception that is not Garmin's
    raises."""
    try:
        details = garmin.call(
            garmin.api.get_activity_details,
            str(garmin_activity_id),
            maxchart=SERIES_MAX_CHART,
            maxpoly=SERIES_MAX_POLY,
        )
    except Exception as exc:
        error = from_garmin_exception(exc)
        if error is None or error.code in REQUEST_FAILURES:
            raise
        if error.code is ErrorCode.NOT_FOUND:
            return empty_series(garmin_activity_id, "gone")
        # The class names only: the library's messages can quote Garmin's answer.
        log.warning(
            "could not read one run's series, the batch goes on",
            extra={"code": error.code.value, "error_chain": error_names(exc)},
        )
        return empty_series(garmin_activity_id, "failed")
    try:
        return to_series(garmin_activity_id, details)
    except ServiceError as exc:
        # parse_details has logged the field paths where the shape broke.
        log.warning(
            "could not read one run's series, the batch goes on", extra={"code": exc.code.value}
        )
        return empty_series(garmin_activity_id, "failed")


def to_series(garmin_activity_id: int, details: object) -> ActivitySeries:
    """Every row with a timer value and a distance, in Garmin's order; raises unavailable() for a
    shape this service cannot read.

    Rows whose timer goes backwards stay: the engine cuts the run there, where this service could
    only guess which side of the jump is right.
    """
    elapsed_s: list[float] = []
    distance_m: list[float] = []
    for elapsed, distance, _ in timed_rows(parse_details(details)):
        # Python's json reads NaN and Infinity, and neither places a sample.
        if math.isfinite(elapsed) and math.isfinite(distance):
            elapsed_s.append(elapsed)
            distance_m.append(distance)
    return ActivitySeries(
        garmin_activity_id=garmin_activity_id,
        outcome="ok",
        elapsed_s=elapsed_s,
        distance_m=distance_m,
    )


def fetch_records(garmin: GarminSession) -> list[GarminRecord] | None:
    """Garmin's records, or None when Garmin would not give them or sent a shape this service
    cannot read: they are only a comparison, so they never fail the series. A 429, a dead login or
    an exception that is not Garmin's raises, the last so that a bug is a 500, not a hidden
    comparison."""
    try:
        raw = garmin.call(garmin.api.get_personal_record)
    except Exception as exc:
        error = from_garmin_exception(exc)
        if error is None or error.code in REQUEST_FAILURES:
            raise
        # The class names only: the library's messages can quote Garmin's answer.
        log.warning(
            "could not read Garmin's records, answered without them",
            extra={"code": error.code.value, "error_chain": error_names(exc)},
        )
        return None
    return to_records(raw)


def to_records(raw: object) -> list[GarminRecord] | None:
    """Garmin's running records at the app's distances, shortest first, the fastest per distance;
    None when the answer is not a list.

    Only items whose typeId maps to a distance are read, so a change in the longest-run, step or
    goal records cannot break anything. A mapped item that does not validate, or holds no positive
    time or no date, says nothing comparable and is skipped.
    """
    # The library answers {} when Garmin sends 204 No Content: an account without records.
    if raw is None or raw == {}:
        return []
    if not isinstance(raw, list):
        log.warning(
            "unexpected personal records answer from Garmin, answered without them",
            extra={"answer": type(raw).__name__},
        )
        return None
    fastest: dict[DistanceKey, GarminRecord] = {}
    for index, item in enumerate(raw):
        mapped = _to_record(index, item)
        if mapped is None:
            continue
        current = fastest.get(mapped.distance_key)
        if current is None or mapped.time_s < current.time_s:
            fastest[mapped.distance_key] = mapped
    return [fastest[key] for key in DISTANCE_KEYS if key in fastest]


def _to_record(index: int, item: Any) -> GarminRecord | None:
    type_id = item.get("typeId") if isinstance(item, dict) else None
    # bool is an int to Python: True would read as typeId 1.
    if not isinstance(type_id, int) or isinstance(type_id, bool):
        return None
    distance_key = GARMIN_RECORD_DISTANCES.get(type_id)
    if distance_key is None:
        return None
    try:
        record = GarminPersonalRecord.model_validate(item)
    except ValidationError as exc:
        # Where the shape broke, never the values: they are the runner's data.
        _skipped(
            [".".join([str(index), *map(str, error["loc"])]) for error in exc.errors()],
        )
        return None
    if record.value is None or not math.isfinite(record.value) or record.value <= 0:
        _skipped([f"{index}.value"])
        return None
    achieved_ms = record.activity_start_date_time_in_gmt or record.pr_start_time_gmt
    if not achieved_ms:
        _skipped([f"{index}.activityStartDateTimeInGMT", f"{index}.prStartTimeGmt"])
        return None
    return GarminRecord(
        distance_key=distance_key,
        time_s=record.value,
        achieved_at=_EPOCH + timedelta(milliseconds=achieved_ms),
    )


def _skipped(fields: list[str]) -> None:
    log.warning("unreadable personal record from Garmin, skipped", extra={"fields": fields})
