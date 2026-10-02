"""POST /activities/{id}/detail, mirroring garminActivityDetailRequestSchema and the response, with
activityDetailSchema and its parts from packages/shared/src/contracts/activity.ts."""

from typing import Annotated, Self

from pydantic import Field, model_validator

from garmin_service.models.base import RequestModel, ResponseModel

NonNegative = Annotated[float, Field(ge=0)]
Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]


class ActivityDetailRequest(RequestModel):
    token_bundle: str = Field(min_length=2)


class ActivityLap(ResponseModel):
    # Lap number as the watch shows it, starting at 1.
    index: int = Field(ge=1)
    distance_m: float = Field(ge=0)
    duration_s: float = Field(ge=0)
    avg_hr: float | None = Field(ge=0)
    # Steps per minute.
    avg_cadence: float | None = Field(ge=0)


class ActivityStreams(ResponseModel):
    """Row-aligned samples: every series present has the length of elapsed_s."""

    elapsed_s: list[NonNegative]
    distance_m: list[NonNegative]
    hr: list[NonNegative | None] | None
    # Steps per minute.
    cadence: list[NonNegative | None] | None
    elevation_m: list[float | None] | None
    speed_mps: list[NonNegative | None] | None

    @model_validator(mode="after")
    def _rows_aligned(self) -> Self:
        rows = len(self.elapsed_s)
        series = (self.distance_m, self.hr, self.cadence, self.elevation_m, self.speed_mps)
        if any(values is not None and len(values) != rows for values in series):
            raise ValueError("every series must have one value per row")
        return self


class HrZoneTime(ResponseModel):
    zone: int = Field(ge=1, le=5)
    low_bpm: float = Field(ge=0)
    seconds: float = Field(ge=0)


class ActivityDetail(ResponseModel):
    laps: list[ActivityLap]
    streams: ActivityStreams
    # [latitude, longitude] in order; None for an indoor run or a manual entry.
    route: list[tuple[Latitude, Longitude]] | None
    # Garmin's five zones in order; None when the run has no heart rate.
    hr_zones: list[HrZoneTime] | None


class ActivityDetailResponse(ResponseModel):
    token_bundle: str = Field(min_length=2)
    detail: ActivityDetail
