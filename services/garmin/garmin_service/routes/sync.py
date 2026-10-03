"""POST /sync: running activities whose local start date is in [startDate, endDate], and on request
the newest runs on Garmin, for the API to find runs deleted there.

The newest runs are one more call under the same login: Garmin's running list from offset 0, as
/history pages it, filtered by the same summarize() as the by-date list, so both sides compare the
same set of runs. They are only a check, so a Garmin failure of that call or an answer this service
cannot read answers recent null and the sync goes on. A 429 or a dead login still fails the whole
request, as on any other call: every later call would fail the same way, and the API must back off
or ask the runner to reconnect.
"""

import logging

from fastapi import APIRouter

from garmin_service.activities import GARMIN_RUNNING_TYPE, listed_items, summarize
from garmin_service.activity_series import REQUEST_FAILURES
from garmin_service.client import ConnectDep, GarminSession
from garmin_service.errors import ServiceError, error_names, from_garmin_exception
from garmin_service.models.sync import RecentRuns, SyncRequest, SyncResponse

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
    recent = recent_runs(garmin, body.recent_limit) if body.recent_limit > 0 else None
    log.info(
        "sync listed activities",
        extra={
            "received": len(raw),
            "returned": len(activities),
            "recent_listed": None if recent is None else recent.listed,
            "recent_runs": None if recent is None else len(recent.garmin_activity_ids),
        },
    )
    return SyncResponse(token_bundle=garmin.token_bundle(), activities=activities, recent=recent)


def recent_runs(garmin: GarminSession, limit: int) -> RecentRuns | None:
    """The runs among the newest `limit` items of Garmin's running list, or None when Garmin would
    not list them or sent a shape this service cannot read. A 429, a dead login or an exception that
    is not Garmin's raises, the last so that a bug is a 500, not a skipped check."""
    try:
        raw = garmin.call(garmin.api.get_activities, 0, limit, GARMIN_RUNNING_TYPE)
    except Exception as exc:
        error = from_garmin_exception(exc)
        if error is None or error.code in REQUEST_FAILURES:
            raise
        # The class names only: the library's messages can quote Garmin's answer.
        log.warning(
            "could not list the newest runs, answered without them",
            extra={"code": error.code.value, "error_chain": error_names(exc)},
        )
        return None
    try:
        items = listed_items(raw)
        runs = summarize(items)
    except ServiceError as exc:
        # listed_items and summarize have logged where the shape broke.
        log.warning(
            "could not read the newest runs, answered without them", extra={"code": exc.code.value}
        )
        return None
    return RecentRuns(
        garmin_activity_ids=[run.garmin_activity_id for run in runs],
        # Each minimum on its own clock, not the last item's: the API's range then holds whichever
        # start Garmin sorts by.
        oldest_start_utc=min((run.start_utc for run in runs), default=None),
        oldest_start_local=min((run.start_local for run in runs), default=None),
        listed=len(items),
    )
