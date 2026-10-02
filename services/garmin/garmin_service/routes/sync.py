"""POST /sync: running activities whose local start date is in [startDate, endDate]."""

import logging
from datetime import UTC, date
from typing import Any

from fastapi import APIRouter
from pydantic import ValidationError

from garmin_service.client import ConnectDep
from garmin_service.errors import unavailable
from garmin_service.models.garmin import GarminActivity
from garmin_service.models.sync import ActivitySummary, SyncRequest, SyncResponse

log = logging.getLogger(__name__)
router = APIRouter()

# Garmin's filter for activity lists; it includes the running subtypes.
GARMIN_RUNNING_TYPE = "running"
INDOOR_TYPE_KEYS = frozenset({"treadmill_running", "indoor_running", "virtual_run"})


@router.post("/sync")
def sync(body: SyncRequest, connect: ConnectDep) -> SyncResponse:
    garmin = connect(body.token_bundle)
    raw = garmin.call(
        garmin.api.get_activities_by_date,
        body.start_date.isoformat(),
        body.end_date.isoformat(),
        GARMIN_RUNNING_TYPE,
    )
    activities = summarize(raw, body.start_date, body.end_date)
    log.info("sync listed activities", extra={"received": len(raw), "returned": len(activities)})
    return SyncResponse(token_bundle=garmin.token_bundle(), activities=activities)


def is_run(type_key: str) -> bool:
    """running, trail_running, treadmill_running, virtual_run, ultra_run, ..."""
    return type_key == "running" or type_key.endswith(("_running", "_run"))


def summarize(raw: list[dict[str, Any]], start: date, end: date) -> list[ActivitySummary]:
    """Map Garmin list items to summaries: runs only, inside the range, each id once.

    Garmin pages by offset, newest first, so an upload during paging can repeat an item; one batch
    with a repeated id would also make the API's upsert touch a row twice.
    """
    seen: set[int] = set()
    summaries: list[ActivitySummary] = []
    for item in raw:
        activity = _parse(item)
        if activity.activity_id in seen or not is_run(activity.activity_type.type_key):
            continue
        if not start <= activity.start_time_local.date() <= end:
            continue
        seen.add(activity.activity_id)
        summaries.append(to_summary(activity))
    return summaries


def to_summary(activity: GarminActivity) -> ActivitySummary:
    type_key = activity.activity_type.type_key
    start_gmt = activity.start_time_gmt
    start_utc = (
        start_gmt.replace(tzinfo=UTC) if start_gmt.tzinfo is None else start_gmt.astimezone(UTC)
    )
    return ActivitySummary(
        garmin_activity_id=activity.activity_id,
        type=type_key,
        start_utc=start_utc,
        start_local=activity.start_time_local.replace(tzinfo=None),
        tz=None,
        distance_m=max(activity.distance or 0.0, 0.0),
        duration_s=max(activity.duration or 0.0, 0.0),
        avg_hr=_positive(activity.average_hr),
        max_hr=_positive(activity.max_hr),
        cadence=_positive(activity.average_running_cadence_in_steps_per_minute),
        calories=_non_negative(activity.calories),
        elevation_gain_m=activity.elevation_gain,
        is_indoor=type_key in INDOOR_TYPE_KEYS,
        is_manual=activity.manual_activity,
    )


def _positive(value: float | None) -> float | None:
    """A 0 bpm or 0 spm average means the sensor had nothing; report it as missing."""
    return value if value is not None and value > 0 else None


def _non_negative(value: float | None) -> float | None:
    return value if value is not None and value >= 0 else None


def _parse(item: object) -> GarminActivity:
    try:
        return GarminActivity.model_validate(item)
    except ValidationError as exc:
        # Where the shape broke, never the values: they are the runner's data.
        fields = [".".join(str(part) for part in error["loc"]) for error in exc.errors()]
        log.warning("unexpected activity shape from Garmin", extra={"fields": fields})
        raise unavailable() from None
