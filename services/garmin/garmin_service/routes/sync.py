"""POST /sync: running activities whose local start date is in [startDate, endDate]."""

import logging

from fastapi import APIRouter

from garmin_service.activities import GARMIN_RUNNING_TYPE, summarize
from garmin_service.client import ConnectDep
from garmin_service.models.sync import SyncRequest, SyncResponse

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/sync")
def sync(body: SyncRequest, connect: ConnectDep) -> SyncResponse:
    garmin = connect(body.token_bundle)
    raw = garmin.call(
        garmin.api.get_activities_by_date,
        body.start_date.isoformat(),
        body.end_date.isoformat(),
        GARMIN_RUNNING_TYPE,
    )
    activities = summarize(raw, within=(body.start_date, body.end_date))
    log.info("sync listed activities", extra={"received": len(raw), "returned": len(activities)})
    return SyncResponse(token_bundle=garmin.token_bundle(), activities=activities)
