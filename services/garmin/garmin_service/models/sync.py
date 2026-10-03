"""POST /sync, mirroring garminSyncRequestSchema, garminActivitySummarySchema and the response."""

from datetime import datetime
from typing import Annotated, Self

from pydantic import Field, model_validator

from garmin_service.models.base import IsoDate, RequestModel, ResponseModel


class SyncRequest(RequestModel):
    token_bundle: str = Field(min_length=2)
    # Inclusive, the runner's local dates (YYYY-MM-DD).
    start_date: IsoDate
    end_date: IsoDate
    # The newest items of Garmin's running list to answer as `recent`; 0 skips that call.
    recent_limit: int = Field(ge=0, le=200)

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
    # Garmin's eventType.typeKey as the runner set it (race, training, uncategorized, ...).
    event_type: str | None = Field(min_length=1)


class RecentRuns(ResponseModel):
    """The newest runs on Garmin, for the API to find runs deleted there."""

    # The runs among the listed items, newest first, filtered as the by-date list is.
    garmin_activity_ids: list[Annotated[int, Field(gt=0)]]
    # The earliest start among the listed runs, each on its own clock: aware UTC, and naive
    # wall-clock in the run's own zone. Garmin orders the list by local start, which can disagree
    # with UTC order (a flight, DST, a watch on the wrong zone), so the API needs both. None when
    # no run is listed.
    oldest_start_utc: datetime | None
    oldest_start_local: datetime | None
    # Items Garmin listed before filtering; fewer than recentLimit means the list reached the
    # runner's first run.
    listed: int = Field(ge=0)


class SyncResponse(ResponseModel):
    token_bundle: str = Field(min_length=2)
    activities: list[ActivitySummary]
    # None when recentLimit was 0, or when that call failed or answered an unreadable shape.
    recent: RecentRuns | None
