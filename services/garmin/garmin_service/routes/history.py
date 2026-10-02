"""POST /history: one page of the runner's whole Garmin history, by offset, newest first."""

import logging

from fastapi import APIRouter

from garmin_service.activities import GARMIN_RUNNING_TYPE, listed_items, summarize
from garmin_service.client import ConnectDep
from garmin_service.models.history import HistoryRequest, HistoryResponse

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/history")
def history(body: HistoryRequest, connect: ConnectDep) -> HistoryResponse:
    garmin = connect(body.token_bundle)
    raw = garmin.call(garmin.api.get_activities, body.start, body.limit, GARMIN_RUNNING_TYPE)
    items = listed_items(raw)
    activities = summarize(items)
    log.info(
        "history listed activities",
        extra={"start": body.start, "listed": len(items), "returned": len(activities)},
    )
    return HistoryResponse(
        token_bundle=garmin.token_bundle(), activities=activities, listed=len(items)
    )
