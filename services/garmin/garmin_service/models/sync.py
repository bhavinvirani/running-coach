"""POST /sync, mirroring garminSyncRequestSchema, garminActivitySummarySchema and the response."""

from datetime import datetime
from typing import Self

from pydantic import Field, model_validator

from garmin_service.models.base import IsoDate, RequestModel, ResponseModel


class SyncRequest(RequestModel):
    token_bundle: str = Field(min_length=2)
    # Inclusive, the runner's local dates (YYYY-MM-DD).
    start_date: IsoDate
    end_date: IsoDate

    @model_validator(mode="after")
    def _start_not_after_end(self) -> Self:
        if self.start_date > self.end_date:
            raise ValueError("startDate must not be after endDate")
        return self


class ActivitySummary(ResponseModel):
    garmin_activity_id: int = Field(gt=0)
    # Garmin's activityType.typeKey: running, treadmill_running, trail_running, ...
    type: str = Field(min_length=1)
    # Aware UTC datetime; serializes as ISO 8601 with a Z.
    start_utc: datetime
    # Naive wall-clock start in the activity's own zone; serializes without an offset.
    start_local: datetime
    # IANA zone; the activity list has none, the detail call fills it later.
    tz: str | None
    distance_m: float = Field(ge=0)
    duration_s: float = Field(ge=0)
    avg_hr: float | None = Field(ge=0)
    max_hr: float | None = Field(ge=0)
    # Steps per minute.
    cadence: float | None = Field(ge=0)
    calories: float | None = Field(ge=0)
    elevation_gain_m: float | None
    is_indoor: bool
    is_manual: bool


class SyncResponse(ResponseModel):
    token_bundle: str = Field(min_length=2)
    activities: list[ActivitySummary]
