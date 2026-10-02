"""The parts of Garmin's raw responses this service reads. Unknown keys are ignored.

Garmin leaves a key out when it has no value (indoor runs have no elevation, manual runs no heart
rate), so everything except identity and start times is optional.
"""

import logging
from datetime import datetime
from typing import Annotated, Any

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    ValidatorFunctionWrapHandler,
    WrapValidator,
)
from pydantic.alias_generators import to_camel

log = logging.getLogger(__name__)


class GarminModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_alias=True, validate_by_name=True, extra="ignore"
    )


class GarminActivityType(GarminModel):
    type_key: str = Field(min_length=1)


class GarminEventType(GarminModel):
    """What the runner tagged the activity as in Garmin Connect: race, training, uncategorized."""

    type_key: str = Field(min_length=1)


def _event_type_or_none(value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
    """The event type is a label, not a metric: a shape Garmin changes makes it null instead of
    failing the whole sync."""
    try:
        return handler(value)
    except ValidationError as exc:
        # Where the shape broke, never the values.
        fields = [".".join(["eventType", *map(str, error["loc"])]) for error in exc.errors()]
        log.warning(
            "unexpected eventType shape from Garmin, reported as null", extra={"fields": fields}
        )
        return None


class GarminActivity(GarminModel):
    """One item of get_activities_by_date / get_activities."""

    activity_id: int = Field(gt=0)
    activity_type: GarminActivityType
    # "YYYY-MM-DD HH:MM:SS" without a zone: UTC for startTimeGMT, wall clock for startTimeLocal.
    start_time_gmt: datetime = Field(alias="startTimeGMT")
    start_time_local: datetime
    distance: float | None = None
    duration: float | None = None
    average_hr: float | None = Field(default=None, alias="averageHR")
    max_hr: float | None = Field(default=None, alias="maxHR")
    average_running_cadence_in_steps_per_minute: float | None = None
    calories: float | None = None
    elevation_gain: float | None = None
    manual_activity: bool = False
    event_type: Annotated[GarminEventType | None, WrapValidator(_event_type_or_none)] = None


class GarminLap(GarminModel):
    """One item of get_activity_splits' lapDTOs. Units: m, s, bpm, steps per minute."""

    # 1-based, as the watch numbers laps.
    lap_index: int | None = None
    distance: float | None = None
    duration: float | None = None
    average_hr: float | None = Field(default=None, alias="averageHR")
    # Both feet: about twice the series' directRunCadence.
    average_run_cadence: float | None = None


class GarminSplits(GarminModel):
    """get_activity_splits. A manual entry has no laps; an empty answer (204) has no key at all."""

    lap_dtos: list[GarminLap] | None = Field(default=None, alias="lapDTOs")


class GarminMetricDescriptor(GarminModel):
    """Which column of every activityDetailMetrics row holds the series named `key`."""

    metrics_index: int = Field(ge=0)
    key: str


class GarminMetricsRow(GarminModel):
    metrics: list[float | None] | None = None


class GarminPolylinePoint(GarminModel):
    lat: float | None = None
    lon: float | None = None


class GarminPolyline(GarminModel):
    polyline: list[GarminPolylinePoint] | None = None


class GarminDetails(GarminModel):
    """get_activity_details: positional sample rows described by metricDescriptors, and the route.

    detailsAvailable is false and the rows are empty for a manual entry; an indoor run has no
    geoPolylineDTO.
    """

    details_available: bool | None = None
    metric_descriptors: list[GarminMetricDescriptor] | None = None
    activity_detail_metrics: list[GarminMetricsRow] | None = None
    geo_polyline_dto: GarminPolyline | None = Field(default=None, alias="geoPolylineDTO")


class GarminHrZone(GarminModel):
    """One item of get_activity_hr_in_timezones: seconds in one of the runner's five zones."""

    zone_number: int
    secs_in_zone: float | None = None
    zone_low_boundary: float | None = None


# 9999-12-31T23:59:59.999Z: a later epoch cannot become a datetime.
MAX_EPOCH_MS = 253_402_300_799_999
EpochMs = Annotated[int, Field(gt=0, le=MAX_EPOCH_MS)]


class GarminPersonalRecord(GarminModel):
    """One item of get_personal_record. typeId says which record: the distance records hold seconds
    in `value`, the longest run meters, and the step and goal records carry activityId 0 and no
    activity fields."""

    type_id: int
    value: float | None = None
    # Epoch milliseconds, UTC: the start of the run that set the record, null for step records.
    activity_start_date_time_in_gmt: EpochMs | None = Field(
        default=None, alias="activityStartDateTimeInGMT"
    )
    # Epoch milliseconds, UTC: when Garmin says the record began.
    pr_start_time_gmt: EpochMs | None = None
