"""POST /activities/{id}/detail: the laps, samples, route and heart-rate zones of one run.

Three library calls share one login: splits, then details, then zones. An id Garmin does not know
is a 404 not_found (errors.py maps it by the cause chain).
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Path

from garmin_service.activity_detail import DETAIL_MAX_CHART, DETAIL_MAX_POLY, to_detail
from garmin_service.client import ConnectDep
from garmin_service.models.activity_detail import ActivityDetailRequest, ActivityDetailResponse
from garmin_service.models.history import MAX_SAFE_INTEGER

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/activities/{garmin_activity_id}/detail")
def activity_detail(
    garmin_activity_id: Annotated[int, Path(gt=0, le=MAX_SAFE_INTEGER)],
    body: ActivityDetailRequest,
    connect: ConnectDep,
) -> ActivityDetailResponse:
    garmin = connect(body.token_bundle)
    activity_id = str(garmin_activity_id)
    splits = garmin.call(garmin.api.get_activity_splits, activity_id)
    details = garmin.call(
        garmin.api.get_activity_details,
        activity_id,
        maxchart=DETAIL_MAX_CHART,
        maxpoly=DETAIL_MAX_POLY,
    )
    hr_zones = garmin.call(garmin.api.get_activity_hr_in_timezones, activity_id)
    detail = to_detail(splits, details, hr_zones)
    log.info(
        "activity detail fetched",
        extra={
            "laps": len(detail.laps),
            "rows": len(detail.streams.elapsed_s),
            "route_points": len(detail.route or []),
            "has_hr_zones": detail.hr_zones is not None,
        },
    )
    return ActivityDetailResponse(token_bundle=garmin.token_bundle(), detail=detail)
