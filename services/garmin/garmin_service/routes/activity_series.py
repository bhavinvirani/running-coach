"""POST /activities/series: the timer and distance samples of up to 10 runs, and Garmin's records.

One login for the whole batch; one details call per distinct run, in request order, then the
records call when asked for. Each run comes back "ok", "gone" (deleted on Garmin) or "failed" (this
run alone could not be read), and the batch goes on; records that cannot be read come back null.
Of Garmin's failures only a 429 or a dead login fails the whole request (errors.py maps it, with a
rotated bundle); an exception that is not Garmin's is a 500.

When every run fails the answer is still 200, each outcome "failed" or "skipped": the API decides
that Garmin is down. Two runs failing in a row already say so, and the API waits SYNC_TIMEOUT_MS
(60 s) for the whole batch, losing a rotated bundle on a timeout. So after FAILED_IN_A_ROW_MAX
failures, or once SERIES_BUDGET_S has passed, no further call starts: the runs left are "skipped",
never asked about, so the API leaves them pending without counting a failed attempt, and the records
are null.
"""

import logging
import time
from collections import Counter

from fastapi import APIRouter

from garmin_service.activity_series import empty_series, fetch_records, fetch_series
from garmin_service.client import ConnectDep
from garmin_service.models.series import ActivitySeries, SeriesRequest, SeriesResponse

log = logging.getLogger(__name__)
router = APIRouter()

# Each failed call costs the library's retries (GARMIN_RETRY_ATTEMPTS, with backoff) against a
# server that is not answering.
FAILED_IN_A_ROW_MAX = 2
# No call starts later than this after the request began: the 60 s the API waits, less one details
# call with its retries in the common case.
SERIES_BUDGET_S = 40.0


@router.post("/activities/series")
def activity_series(body: SeriesRequest, connect: ConnectDep) -> SeriesResponse:
    deadline = time.monotonic() + SERIES_BUDGET_S
    garmin = connect(body.token_bundle)
    fetched: dict[int, ActivitySeries] = {}
    failed_in_a_row = 0

    def stopped() -> bool:
        return failed_in_a_row >= FAILED_IN_A_ROW_MAX or time.monotonic() >= deadline

    for garmin_activity_id in body.garmin_activity_ids:
        if garmin_activity_id in fetched:
            continue  # a repeated id costs Garmin no second call
        if stopped():
            fetched[garmin_activity_id] = empty_series(garmin_activity_id, "skipped")
            continue
        series = fetch_series(garmin, garmin_activity_id)
        failed_in_a_row = failed_in_a_row + 1 if series.outcome == "failed" else 0
        fetched[garmin_activity_id] = series
    records = fetch_records(garmin) if body.include_records and not stopped() else None
    outcomes = Counter(series.outcome for series in fetched.values())
    log.info(
        "activity series fetched",
        extra={
            "runs": len(fetched),
            "ok": outcomes["ok"],
            "gone": outcomes["gone"],
            "failed": outcomes["failed"],
            "skipped": outcomes["skipped"],
            "rows": sum(len(series.elapsed_s) for series in fetched.values()),
            "records": None if records is None else len(records),
        },
    )
    return SeriesResponse(
        token_bundle=garmin.token_bundle(),
        series=[fetched[garmin_activity_id] for garmin_activity_id in body.garmin_activity_ids],
        records=records,
    )
