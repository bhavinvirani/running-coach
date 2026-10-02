"""POST /activities/series, mirroring garminSeriesRequestSchema, garminActivitySeriesSchema and
garminSeriesResponseSchema in packages/shared/src/contracts/garmin.ts, with garminRecordSchema from
packages/shared/src/contracts/personal-bests.ts."""

from datetime import datetime
from typing import Annotated, Literal, Self, get_args

from pydantic import Field, model_validator

from garmin_service.models.base import RequestModel, ResponseModel
from garmin_service.models.history import MAX_SAFE_INTEGER

# GARMIN_SERIES_BATCH_MAX: each run is one Garmin call, and one request must stay well inside the
# API client's timeout.
SERIES_BATCH_MAX = 10

# distanceKeySchema in packages/shared/src/distances.ts, shortest first.
DistanceKey = Literal[
    "1k", "1mi", "2mi", "5k", "5mi", "10k", "15k", "10mi", "20k", "half", "marathon"
]
DISTANCE_KEYS: tuple[DistanceKey, ...] = get_args(DistanceKey)

GarminActivityId = Annotated[int, Field(gt=0, le=MAX_SAFE_INTEGER)]
NonNegative = Annotated[float, Field(ge=0)]


class SeriesRequest(RequestModel):
    token_bundle: str = Field(min_length=2)
    garmin_activity_ids: list[GarminActivityId] = Field(max_length=SERIES_BATCH_MAX)
    include_records: bool


# garminSeriesOutcomeSchema. "ok": Garmin answered, with samples or none (a run it holds no detail
# rows for); "gone": Garmin answered 404, the run was deleted there; "failed": Garmin was asked and
# this run could not be read, so the API counts an attempt; "skipped": never asked, because the
# route stopped early (failures in a row or its time budget), so the API leaves it as it was.
SeriesOutcome = Literal["ok", "gone", "failed", "skipped"]


class ActivitySeries(ResponseModel):
    """One run's samples, row-aligned; both empty unless the outcome is "ok"."""

    garmin_activity_id: GarminActivityId
    outcome: SeriesOutcome
    # Timer seconds from the start in Garmin's row order; the engine cuts wherever they go back.
    elapsed_s: list[NonNegative]
    distance_m: list[NonNegative]

    @model_validator(mode="after")
    def _rows_aligned(self) -> Self:
        if len(self.distance_m) != len(self.elapsed_s):
            raise ValueError("distanceM must have the length of elapsedS")
        if self.outcome != "ok" and self.elapsed_s:
            raise ValueError("only an ok run carries samples")
        return self


class GarminRecord(ResponseModel):
    """One of Garmin's own running records at a distance the app knows."""

    distance_key: DistanceKey
    time_s: float = Field(gt=0)
    # Aware UTC datetime; serializes as ISO 8601 with a Z.
    achieved_at: datetime


class SeriesResponse(ResponseModel):
    token_bundle: str = Field(min_length=2)
    # One entry per requested id, in request order.
    series: list[ActivitySeries]
    # None unless the request set includeRecords, and None when Garmin's records could not be read:
    # they are only a comparison, so they never fail the series.
    records: list[GarminRecord] | None
