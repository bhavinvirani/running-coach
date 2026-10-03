"""The runner's workouts on Garmin: build a RunningWorkout from the contract, apply one action,
read the calendar.

Builder: one running segment; each step ends by time (seconds) or by distance (meters), with a pace
target in m/s (slower pace is the lower limit) or none; a repeat is a repeat group. Step orders run
on across the whole workout, children included: warmup 1, repeat 2 with children 3 and 4, cooldown 5
is the shape spike 2 put on an Instinct 2 Solar (spikes/garmin/spike2_workout.py). The dicts are
the ones garminconnect's create_*_step helpers build; only the helpers for interval steps end by
distance or take a pace target, so steps are built here from the same values, and the tests pin
them to the helpers' output.

Writes go through client.post and client.delete directly, so the library retries none of them and
an upload is never sent twice: one action is at most two calls, and its failure stops the batch.
"""

import logging
import re
import traceback
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date
from typing import Any, TypeGuard

from garminconnect.workout import (
    ConditionType,
    ExecutableStep,
    PaceTarget,
    RepeatGroup,
    RunningWorkout,
    SportType,
    StepType,
    TargetType,
    WorkoutSegment,
    create_repeat_group,
)

from garmin_service.client import GarminSession
from garmin_service.errors import (
    ServiceError,
    error_names,
    from_garmin_exception,
    from_write_exception,
    unavailable,
)
from garmin_service.models.history import MAX_SAFE_INTEGER
from garmin_service.models.problem import ErrorCode
from garmin_service.models.workouts import (
    CalendarEntry,
    CreateAction,
    GarminWorkout,
    MoveAction,
    PaceBand,
    RemoveAction,
    UnscheduleAction,
    WorkoutAction,
    WorkoutOutcome,
    WorkoutRepeat,
    WorkoutStep,
)
from garmin_service.models.workouts import StepType as StepTypeKey

log = logging.getLogger(__name__)

RUNNING_SPORT: dict[str, Any] = {
    "sportTypeId": SportType.RUNNING,
    "sportTypeKey": "running",
    "displayOrder": 1,
}
_STEP_TYPES: dict[StepTypeKey, dict[str, Any]] = {
    "warmup": {"stepTypeId": StepType.WARMUP, "stepTypeKey": "warmup", "displayOrder": 1},
    "cooldown": {"stepTypeId": StepType.COOLDOWN, "stepTypeKey": "cooldown", "displayOrder": 2},
    "interval": {"stepTypeId": StepType.INTERVAL, "stepTypeKey": "interval", "displayOrder": 3},
    "recovery": {"stepTypeId": StepType.RECOVERY, "stepTypeKey": "recovery", "displayOrder": 4},
}
_ENDS_BY_TIME: dict[str, Any] = {
    "conditionTypeId": ConditionType.TIME,
    "conditionTypeKey": "time",
    "displayOrder": 2,
    "displayable": True,
}
_ENDS_BY_DISTANCE: dict[str, Any] = {
    "conditionTypeId": ConditionType.DISTANCE,
    "conditionTypeKey": "distance",
    "displayOrder": 3,
    "displayable": True,
}
_NO_TARGET: dict[str, Any] = {
    "workoutTargetTypeId": TargetType.NO_TARGET,
    "workoutTargetTypeKey": "no.target",
    "displayOrder": 1,
}
_ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def pace_target(pace: PaceBand) -> PaceTarget:
    """A pace band in s/km as Garmin's pace zone in m/s: the slower pace is the lower limit."""
    return PaceTarget(lower_limit=1000 / pace.slow_s_per_km, upper_limit=1000 / pace.fast_s_per_km)


def build_step(step: WorkoutStep, step_order: int) -> ExecutableStep:
    if step.distance_m is not None:
        ends, end_value = _ENDS_BY_DISTANCE, step.distance_m
    elif step.duration_s is not None:
        ends, end_value = _ENDS_BY_TIME, step.duration_s
    else:  # pragma: no cover - WorkoutStep rejects a step with neither
        raise ValueError("A step is by distance or by time")
    target: dict[str, Any] = {"targetType": dict(_NO_TARGET)}
    if step.pace is not None:
        pace = pace_target(step.pace)
        target = {
            "targetType": {
                "workoutTargetTypeId": pace.target_type,
                "workoutTargetTypeKey": pace.target_type_key,
                "displayOrder": 1,
            },
            "targetValueOne": pace.lower_limit,
            "targetValueTwo": pace.upper_limit,
        }
    return ExecutableStep(
        stepOrder=step_order,
        stepType=dict(_STEP_TYPES[step.type]),
        endCondition=dict(ends),
        endConditionValue=float(end_value),
        **target,
    )


def build_workout(workout: GarminWorkout) -> RunningWorkout:
    steps: list[ExecutableStep | RepeatGroup] = []
    order = 0
    for item in workout.steps:
        order += 1
        if isinstance(item, WorkoutRepeat):
            group_order = order
            children: list[ExecutableStep | RepeatGroup] = []
            for child in item.steps:
                order += 1
                children.append(build_step(child, order))
            steps.append(create_repeat_group(item.repeat, children, step_order=group_order))
        else:
            steps.append(build_step(item, order))
    return RunningWorkout(
        workoutName=workout.name,
        estimatedDurationInSecs=workout.estimated_duration_s,
        workoutSegments=[
            WorkoutSegment(segmentOrder=1, sportType=dict(RUNNING_SPORT), workoutSteps=steps)
        ],
    )


@dataclass
class Held:
    """The ids Garmin holds for an action's ref, updated as each call of the action succeeds."""

    workout_id: int | None
    schedule_id: int | None


def held_before(action: WorkoutAction) -> Held:
    match action:
        case CreateAction():
            return Held(None, None)
        case MoveAction() | RemoveAction():
            return Held(action.workout_id, action.schedule_id)
        case UnscheduleAction():
            return Held(None, action.schedule_id)


def apply(garmin: GarminSession, action: WorkoutAction, held: Held) -> WorkoutOutcome:
    """Run one action; on a failure `held` says what Garmin holds at that point, and it raises."""
    match action:
        case CreateAction():
            uploaded = garmin.call(garmin.api.upload_running_workout, build_workout(action.workout))
            held.workout_id = _positive_id(uploaded, "workoutId", "upload")
            held.schedule_id = _schedule(garmin, held.workout_id, action.date)
            return "done"
        case MoveAction():
            _unschedule_held(garmin, held)
            try:
                held.schedule_id = _schedule(garmin, action.workout_id, action.date)
            except Exception as exc:
                if not _is_not_found(exc):
                    raise
                # Deleted in Garmin Connect: the API forgets its ids and creates it again.
                held.workout_id = None
                return "gone"
            return "done"
        case RemoveAction():
            _unschedule_held(garmin, held)
            _ignoring_not_found(garmin, garmin.api.delete_workout, action.workout_id)
            held.workout_id = None
            return "done"
        case UnscheduleAction():
            _unschedule_held(garmin, held)
            return "done"


def stop_for(exc: Exception) -> ServiceError:
    """What stopped the batch, as a whole-request failure would have answered it.

    An exception that is neither Garmin's nor the network's is a bug; it still answers the results
    so far (code internal) rather than a 500, since the writes before it cannot be taken back.
    """
    if isinstance(exc, ServiceError):
        return exc
    error = from_write_exception(exc)
    if error is not None:
        return error
    # The class and stack frames only, as for any 500: messages can quote payloads.
    frames = [
        f"{frame.filename}:{frame.lineno} in {frame.name}"
        for frame in traceback.extract_tb(exc.__traceback__)
    ]
    log.error(
        "unexpected error in a workout action",
        extra={"error_chain": error_names(exc), "stack": frames},
    )
    return ServiceError(500, ErrorCode.INTERNAL, "Unexpected error.")


def months_between(start: date, end: date) -> Iterator[tuple[int, int]]:
    """(year, 1-based month) of every month from start's to end's, inclusive."""
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        yield year, month
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)


def read_calendar_month(garmin: GarminSession, year: int, month: int) -> list[Any] | None:
    """One month of Garmin's calendar items; None when it could not be read. Never raises: the
    calendar never fails the batch, whose writes are already done."""
    try:
        answer = garmin.call(garmin.api.get_scheduled_workouts, year, month)
    except Exception as exc:
        error = from_garmin_exception(exc)
        # Class names only: the library's messages can quote Garmin's answer.
        log.warning(
            "could not read the Garmin calendar, answered without it",
            extra={
                "code": None if error is None else error.code.value,
                "error_chain": error_names(exc),
            },
        )
        return None
    items = answer.get("calendarItems") if isinstance(answer, dict) else None
    if not isinstance(items, list):
        log.warning(
            "unexpected calendar answer from Garmin, answered without it",
            extra={"answer": type(answer).__name__},
        )
        return None
    return items


def calendar_entries(items: list[Any], start: date, end: date) -> list[CalendarEntry]:
    """The workouts scheduled from start to end; other item types and unreadable items are left
    out."""
    entries: list[CalendarEntry] = []
    for item in items:
        if not isinstance(item, dict) or item.get("itemType") != "workout":
            continue
        schedule_id, workout_id = item.get("id"), item.get("workoutId")
        day = _iso_day(item.get("date"))
        if not _is_id(schedule_id) or not _is_id(workout_id) or day is None:
            continue
        if not start <= day <= end:
            continue
        title = item.get("title")
        entries.append(
            CalendarEntry(
                schedule_id=schedule_id,
                workout_id=workout_id,
                date=day,
                title=title if isinstance(title, str) else None,
            )
        )
    return entries


def _schedule(garmin: GarminSession, workout_id: int, day: date) -> int:
    scheduled = garmin.call(garmin.api.schedule_workout, workout_id, day.isoformat())
    return _positive_id(scheduled, "workoutScheduleId", "schedule")


def _unschedule_held(garmin: GarminSession, held: Held) -> None:
    if held.schedule_id is not None:
        _ignoring_not_found(garmin, garmin.api.unschedule_workout, held.schedule_id)
        held.schedule_id = None


def _ignoring_not_found(garmin: GarminSession, fn: Callable[[int], object], item_id: int) -> None:
    """Unschedule or delete: a 404 means it is already gone, which is what was asked."""
    try:
        garmin.call(fn, item_id)
    except Exception as exc:
        if not _is_not_found(exc):
            raise


def _is_not_found(exc: Exception) -> bool:
    error = from_write_exception(exc)
    return error is not None and error.code is ErrorCode.NOT_FOUND


def _positive_id(answer: object, key: str, call: str) -> int:
    value = answer.get(key) if isinstance(answer, dict) else None
    if not _is_id(value):
        # The key and the answer's type only: the answer holds the runner's workout.
        log.warning(
            "unexpected answer from Garmin",
            extra={"call": call, "field": key, "answer": type(answer).__name__},
        )
        raise unavailable()
    return value


def _is_id(value: object) -> TypeGuard[int]:
    # bool is an int to Python: True would read as id 1.
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= MAX_SAFE_INTEGER


def _iso_day(value: object) -> date | None:
    if not isinstance(value, str) or not _ISO_DATE.fullmatch(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None
