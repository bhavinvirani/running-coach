"""POST /workouts/sync, mirroring garminWorkoutSchema with its steps, garminWorkoutActionSchema,
garminWorkoutSyncRequestSchema and garminWorkoutSyncResponseSchema in
packages/shared/src/contracts/garmin.ts."""

from datetime import date
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from garmin_service.models.base import IsoDate, RequestModel, ResponseModel
from garmin_service.models.history import MAX_SAFE_INTEGER
from garmin_service.models.problem import ErrorCode

# GARMIN_WORKOUT_BATCH_MAX: at most two paced calls per action, plus the login and the calendar
# read, inside the API client's timeout.
WORKOUT_BATCH_MAX = 8
# GARMIN_WORKOUT_NAME_MAX: readable on a watch face.
WORKOUT_NAME_MAX = 60

PositiveInt = Annotated[int, Field(gt=0, le=MAX_SAFE_INTEGER)]
GarminWorkoutId = PositiveInt
GarminScheduleId = PositiveInt
Ref = Annotated[str, Field(min_length=1, max_length=64)]
StepType = Literal["warmup", "interval", "recovery", "cooldown"]
ActionKind = Literal["create", "move", "remove", "unschedule"]


class PaceBand(RequestModel):
    """Seconds per km, fast end first, as the plan stores it."""

    fast_s_per_km: PositiveInt
    slow_s_per_km: PositiveInt

    @model_validator(mode="after")
    def _fast_not_slower(self) -> Self:
        if self.fast_s_per_km > self.slow_s_per_km:
            raise ValueError("The fast end cannot be slower than the slow end")
        return self


class WorkoutStep(RequestModel):
    """Ends after a distance or a time; with a pace band, or open (no target) when pace is None."""

    type: StepType
    distance_m: PositiveInt | None
    duration_s: PositiveInt | None
    pace: PaceBand | None

    @model_validator(mode="after")
    def _distance_or_time(self) -> Self:
        if (self.distance_m is None) == (self.duration_s is None):
            raise ValueError("A step is by distance or by time")
        return self


class WorkoutRepeat(RequestModel):
    repeat: Annotated[int, Field(ge=2, le=MAX_SAFE_INTEGER)]
    steps: list[WorkoutStep] = Field(min_length=1)


class GarminWorkout(RequestModel):
    name: str = Field(min_length=1, max_length=WORKOUT_NAME_MAX)
    estimated_duration_s: Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
    steps: list[WorkoutStep | WorkoutRepeat] = Field(min_length=1)


class CreateAction(RequestModel):
    """Upload the workout, then schedule it on `date`."""

    action: Literal["create"]
    ref: Ref
    date: IsoDate
    workout: GarminWorkout


class MoveAction(RequestModel):
    """Unschedule `schedule_id` when set, then schedule `workout_id` on `date`."""

    action: Literal["move"]
    ref: Ref
    workout_id: GarminWorkoutId
    schedule_id: GarminScheduleId | None
    date: IsoDate


class RemoveAction(RequestModel):
    """Unschedule `schedule_id` when set, then delete `workout_id`: only a workout the app made."""

    action: Literal["remove"]
    ref: Ref
    workout_id: GarminWorkoutId
    schedule_id: GarminScheduleId | None


class UnscheduleAction(RequestModel):
    """Take a workout the app did not create off the calendar; the workout itself stays."""

    action: Literal["unschedule"]
    ref: Ref
    schedule_id: GarminScheduleId


WorkoutAction = Annotated[
    CreateAction | MoveAction | RemoveAction | UnscheduleAction, Field(discriminator="action")
]


class WorkoutSyncRequest(RequestModel):
    token_bundle: str = Field(min_length=2)
    actions: list[WorkoutAction] = Field(max_length=WORKOUT_BATCH_MAX)
    # Inclusive, the runner's local dates (YYYY-MM-DD).
    calendar_start: IsoDate
    calendar_end: IsoDate
    # False skips the calendar read and answers calendar null: the caller has no use for the list.
    read_calendar: bool

    @model_validator(mode="after")
    def _start_not_after_end(self) -> Self:
        if self.calendar_start > self.calendar_end:
            raise ValueError("calendarStart must not be after calendarEnd")
        return self


# garminWorkoutOutcomeSchema. done: it completed; gone: the workout it names no longer exists on
# Garmin; failed: the failure that stopped the batch hit it, possibly halfway; skipped: never tried.
WorkoutOutcome = Literal["done", "gone", "failed", "skipped"]


class WorkoutResult(ResponseModel):
    """One per action, in request order: the ids Garmin holds for the ref after the action."""

    ref: Ref
    action: ActionKind
    outcome: WorkoutOutcome
    workout_id: GarminWorkoutId | None
    schedule_id: GarminScheduleId | None


class CalendarEntry(ResponseModel):
    """A workout on the runner's Garmin calendar (calendarItems with itemType "workout")."""

    schedule_id: GarminScheduleId
    workout_id: GarminWorkoutId
    date: date
    title: str | None


class WorkoutStop(ResponseModel):
    """Why the batch stopped: what a whole-request failure would have answered."""

    code: ErrorCode
    # Optional, not nullable, in the contract: left out of the JSON when there is none.
    retry_after_seconds: int | None = Field(default=None, ge=0, exclude_if=lambda v: v is None)


class WorkoutSyncResponse(ResponseModel):
    token_bundle: str = Field(min_length=2)
    results: list[WorkoutResult]
    stopped: WorkoutStop | None
    # Null when not asked for, or the batch stopped, ran out of time or the calendar read failed.
    calendar: list[CalendarEntry] | None
