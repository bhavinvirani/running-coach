"""POST /workouts/sync: create, move, remove and unschedule workouts on the runner's Garmin calendar
in one login, then read the calendar between calendarStart and calendarEnd.

Writes are not idempotent: an upload sent twice is two workouts. So only a failed login answers a
problem (nothing was done). After it, any failure stops the batch and answers 200 with what each
action did: the failed one says which ids Garmin now holds for it (a create that uploaded but did
not schedule answers its workoutId), the later ones are "skipped", and `stopped` carries the code
and retry delay the failure would have answered on its own. The calendar is read only when every
action is done or gone; its failure answers calendar null and never fails the batch.

No action starts once WORKOUTS_BUDGET_S has passed: the API waits for the whole batch and loses a
rotated bundle on a timeout. The actions left are "skipped" with no stop, and the calendar is null.
"""

import logging
import time
from collections import Counter

from fastapi import APIRouter

from garmin_service import workouts
from garmin_service.client import ConnectDep, GarminSession
from garmin_service.errors import error_names
from garmin_service.models.workouts import (
    CalendarEntry,
    WorkoutAction,
    WorkoutOutcome,
    WorkoutResult,
    WorkoutStop,
    WorkoutSyncRequest,
    WorkoutSyncResponse,
)

log = logging.getLogger(__name__)
router = APIRouter()

# No action or calendar read starts later than this after the request began: what the API waits,
# less one write that hangs to the library's 15 s request timeout.
WORKOUTS_BUDGET_S = 40.0

# The clock the budget runs on; tests replace it.
_now = time.monotonic


@router.post("/workouts/sync")
def workouts_sync(body: WorkoutSyncRequest, connect: ConnectDep) -> WorkoutSyncResponse:
    deadline = _now() + WORKOUTS_BUDGET_S
    garmin = connect(body.token_bundle)
    results: list[WorkoutResult] = []
    stopped: WorkoutStop | None = None
    out_of_time = False

    for action in body.actions:
        out_of_time = out_of_time or _now() >= deadline
        held = workouts.held_before(action)
        if stopped is not None or out_of_time:
            results.append(_result(action, "skipped", held))
            continue
        try:
            outcome = workouts.apply(garmin, action, held)
        except Exception as exc:
            error = workouts.stop_for(exc)
            log.warning(
                "workout batch stopped",
                extra={
                    "action": action.action,
                    "code": error.code.value,
                    "error_chain": error_names(exc),
                },
            )
            stopped = WorkoutStop(code=error.code, retry_after_seconds=error.retry_after_seconds)
            results.append(_result(action, "failed", held))
            continue
        results.append(_result(action, outcome, held))

    complete = all(result.outcome in ("done", "gone") for result in results)
    calendar = _calendar(garmin, body, deadline) if complete else None
    outcomes = Counter(result.outcome for result in results)
    log.info(
        "workout batch finished",
        extra={
            "actions": len(results),
            "done": outcomes["done"],
            "gone": outcomes["gone"],
            "failed": outcomes["failed"],
            "skipped": outcomes["skipped"],
            "stopped": None if stopped is None else stopped.code.value,
            "calendar": None if calendar is None else len(calendar),
        },
    )
    return WorkoutSyncResponse(
        token_bundle=garmin.token_bundle(),
        results=results,
        stopped=stopped,
        calendar=calendar,
    )


def _result(action: WorkoutAction, outcome: WorkoutOutcome, held: workouts.Held) -> WorkoutResult:
    return WorkoutResult(
        ref=action.ref,
        action=action.action,
        outcome=outcome,
        workout_id=held.workout_id,
        schedule_id=held.schedule_id,
    )


def _calendar(
    garmin: GarminSession, body: WorkoutSyncRequest, deadline: float
) -> list[CalendarEntry] | None:
    """Every workout scheduled in the range, one call per month it touches; None when a month
    could not be read or the budget ran out first."""
    entries: dict[int, CalendarEntry] = {}
    for year, month in workouts.months_between(body.calendar_start, body.calendar_end):
        if _now() >= deadline:
            log.warning("no time left to read the Garmin calendar, answered without it")
            return None
        items = workouts.read_calendar_month(garmin, year, month)
        if items is None:
            return None
        for entry in workouts.calendar_entries(items, body.calendar_start, body.calendar_end):
            entries[entry.schedule_id] = entry
    return sorted(entries.values(), key=lambda entry: (entry.date, entry.schedule_id))
