"""Garmin's activity list items as shared summaries, for /sync and /history alike."""

import logging
from collections.abc import Sequence
from datetime import UTC, date

from pydantic import ValidationError

from garmin_service.errors import unavailable
from garmin_service.models.garmin import GarminActivity
from garmin_service.models.sync import ActivitySummary

log = logging.getLogger(__name__)

# Garmin's filter for activity lists; it includes the running subtypes.
GARMIN_RUNNING_TYPE = "running"
INDOOR_TYPE_KEYS = frozenset({"treadmill_running", "indoor_running", "virtual_run"})


def is_run(type_key: str) -> bool:
    """running, trail_running, treadmill_running, virtual_run, ultra_run, ..."""
    return type_key == "running" or type_key.endswith(("_running", "_run"))


def listed_items(raw: object) -> list[object]:
    """Garmin's answer to a list call; get_activities is typed to return an object as well."""
    if not isinstance(raw, list):
        log.warning("unexpected activity list from Garmin", extra={"answer": type(raw).__name__})
        raise unavailable()
    return raw


def summarize(
    raw: Sequence[object], within: tuple[date, date] | None = None
) -> list[ActivitySummary]:
    """Map Garmin list items to summaries: runs only, each id once, and when `within` is given only
    those whose local start date is in that inclusive range.

    Garmin pages by offset, newest first, so an upload during paging can repeat an item; one batch
    with a repeated id would also make the API's upsert touch a row twice.
    """
    seen: set[int] = set()
    summaries: list[ActivitySummary] = []
    for item in raw:
        activity = _parse(item)
        if activity.activity_id in seen or not is_run(activity.activity_type.type_key):
            continue
        if within is not None and not within[0] <= activity.start_time_local.date() <= within[1]:
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
        avg_hr=positive(activity.average_hr),
        max_hr=positive(activity.max_hr),
        cadence=positive(activity.average_running_cadence_in_steps_per_minute),
        calories=_non_negative(activity.calories),
        elevation_gain_m=activity.elevation_gain,
        is_indoor=type_key in INDOOR_TYPE_KEYS,
        is_manual=activity.manual_activity,
    )


def positive(value: float | None) -> float | None:
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
