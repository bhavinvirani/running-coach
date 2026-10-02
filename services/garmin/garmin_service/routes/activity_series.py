"""POST /activities/series: the timer and distance samples of up to 10 runs, and Garmin's records.

One login for the whole batch; one details call per distinct run, in request order, then the
records call when asked for. A run Garmin no longer has comes back empty and the batch goes on;
any other failure fails the whole request (errors.py maps it, with a rotated bundle).
"""

import logging

from fastapi import APIRouter

from garmin_service.activity_series import details_or_none, to_records, to_series
from garmin_service.client import ConnectDep
from garmin_service.models.series import ActivitySeries, SeriesRequest, SeriesResponse

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/activities/series")
def activity_series(body: SeriesRequest, connect: ConnectDep) -> SeriesResponse:
    garmin = connect(body.token_bundle)
    fetched: dict[int, ActivitySeries] = {}
    not_found = 0
    for garmin_activity_id in body.garmin_activity_ids:
        if garmin_activity_id in fetched:
            continue  # a repeated id costs Garmin no second call
        details = details_or_none(garmin, garmin_activity_id)
        not_found += details is None
        fetched[garmin_activity_id] = to_series(garmin_activity_id, details)
    records = (
        to_records(garmin.call(garmin.api.get_personal_record)) if body.include_records else None
    )
    log.info(
        "activity series fetched",
        extra={
            "runs": len(fetched),
            "not_found": not_found,
            "rows": sum(len(series.elapsed_s) for series in fetched.values()),
            "records": None if records is None else len(records),
        },
    )
    return SeriesResponse(
        token_bundle=garmin.token_bundle(),
        series=[fetched[garmin_activity_id] for garmin_activity_id in body.garmin_activity_ids],
        records=records,
    )
