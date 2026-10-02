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
