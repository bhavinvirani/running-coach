"""POST /history, mirroring garminHistoryRequestSchema and garminHistoryResponseSchema."""

from pydantic import Field

from garmin_service.models.base import RequestModel, ResponseModel
from garmin_service.models.sync import ActivitySummary

# zod's .int() stops at Number.MAX_SAFE_INTEGER.
MAX_SAFE_INTEGER = 2**53 - 1


class HistoryRequest(RequestModel):
    token_bundle: str = Field(min_length=2)
    # Offset into Garmin's running list, newest first: 0 is the latest run.
    start: int = Field(ge=0, le=MAX_SAFE_INTEGER)
    limit: int = Field(ge=1, le=200)


class HistoryResponse(ResponseModel):
    token_bundle: str = Field(min_length=2)
    # The runs in the page, newest first; non-runs and repeated ids are left out.
    activities: list[ActivitySummary]
    # Items Garmin listed before filtering: the offset advances by this, and fewer than `limit`
    # means nothing older is left.
    listed: int = Field(ge=0)
