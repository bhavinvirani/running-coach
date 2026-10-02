"""The parts of Garmin's raw responses this service reads. Unknown keys are ignored.

Garmin leaves a key out when it has no value (indoor runs have no elevation, manual runs no heart
rate), so everything except identity and start times is optional.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class GarminModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_alias=True, validate_by_name=True, extra="ignore"
    )


class GarminActivityType(GarminModel):
    type_key: str = Field(min_length=1)


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
