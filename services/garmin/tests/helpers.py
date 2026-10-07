"""Shared test data and a scripted Garmin for cases the fixture files do not cover."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from garmin_service.client import GARMIN_RETRY_ATTEMPTS, Connect, GarminSession, login
from garmin_service.fake_client import FakeGarmin, FakeTokenStore
from garmin_service.password_login import GarminFactory

TEST_SECRET = "test-secret-not-real"
BASE_BUNDLE: dict[str, str] = {
    "di_token": "fixture-token",
    "di_refresh_token": "fixture-refresh",
    "di_client_id": "fixture-client",
}
# What a scripted password login (FakeLogin) dumps once Garmin let it in.
LOGIN_BUNDLE = json.dumps(
    {
        "di_token": "login-di-token-not-real",
        "di_refresh_token": "login-refresh-token-not-real",
        "di_client_id": "login-client-not-real",
    }
)
NO_TOKENS = json.dumps({"di_token": None, "di_refresh_token": None, "di_client_id": None})
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
JSON_SCHEMA_DIR = (
    Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "json-schema"
)


def bundle(**extra: str) -> str:
    """A fixture-mode token bundle; extra keys such as fixture="expired" pick the behaviour."""
    return json.dumps({**BASE_BUNDLE, **extra})


def rotated(sent: str) -> str:
    """The bundle the fake returns after a simulated refresh of `sent`."""
    return json.dumps({**json.loads(sent), "fixture": "rotated"})


def read_fixture(name: str) -> Any:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def raw_run(**overrides: Any) -> dict[str, Any]:
    """The long run from sync.json, with fields replaced."""
    item: dict[str, Any] = copy.deepcopy(read_fixture("sync.json")[0])
    item.update(overrides)
    return item


def by_id(activities: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {activity["garminActivityId"]: activity for activity in activities}


def assert_valid(name: str, instance: Any) -> None:
    """instance matches packages/shared/src/json-schema/<name>.json, exported from zod."""
    schema = json.loads((JSON_SCHEMA_DIR / f"{name}.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    errors = [f"{list(e.absolute_path)}: {e.message}" for e in validator.iter_errors(instance)]
    assert errors == [], errors


# POST /workouts/sync request bodies. WINDOW is the calendar range they ask for.
WINDOW = {"calendarStart": "2026-10-26", "calendarEnd": "2026-11-01"}
EASY_RUN = {
    "name": "Easy Run 5 km",
    "estimatedDurationS": 1800,
    "steps": [
        {
            "type": "interval",
            "distanceM": 5000,
            "durationS": None,
            "pace": {"fastSPerKm": 330, "slowSPerKm": 360},
        }
    ],
}
# A workout and its schedule the app created earlier.
OURS = 900_000_777
OURS_SCHEDULE = 800_000_777


def create(ref: str = "s-create", day: str = "2026-10-27") -> dict[str, Any]:
    return {"action": "create", "ref": ref, "date": day, "workout": EASY_RUN}


def move(
    ref: str = "s-move",
    workout_id: int = OURS,
    schedule_id: int | None = OURS_SCHEDULE,
    day: str = "2026-10-28",
) -> dict[str, Any]:
    return {
        "action": "move",
        "ref": ref,
        "workoutId": workout_id,
        "scheduleId": schedule_id,
        "date": day,
    }


def remove(
    ref: str = "s-remove", workout_id: int = OURS + 1, schedule_id: int | None = OURS_SCHEDULE + 1
) -> dict[str, Any]:
    return {"action": "remove", "ref": ref, "workoutId": workout_id, "scheduleId": schedule_id}


def unschedule(ref: str = "6000000004", schedule_id: int = 6_000_000_004) -> dict[str, Any]:
    return {"action": "unschedule", "ref": ref, "scheduleId": schedule_id}


def workout_sync_body(
    *actions: dict[str, Any], token_bundle: str | None = None, read_calendar: bool = True
) -> dict[str, Any]:
    return {
        "tokenBundle": bundle() if token_bundle is None else token_bundle,
        "actions": list(actions),
        **WINDOW,
        "readCalendar": read_calendar,
    }


class ScriptedGarmin:
    """Implements GarminApi with canned answers and records every call."""

    def __init__(
        self,
        *,
        activities: list[dict[str, Any]] | None = None,
        login_error: BaseException | None = None,
        activities_error: BaseException | None = None,
        recent_error: BaseException | None = None,
        list_answer: Any = None,
        splits: dict[str, Any] | None = None,
        details: dict[str, Any] | None = None,
        hr_zones: dict[str, Any] | list[Any] | None = None,
        detail_error: BaseException | None = None,
        details_errors: dict[str, BaseException] | None = None,
        details_answers: dict[str, Any] | None = None,
        personal_records: Any = None,
        records_error: BaseException | None = None,
        rotate_to: str | None = None,
        write_errors: dict[str, BaseException] | None = None,
        upload_answer: Any = None,
        schedule_answer: Any = None,
        calendar: Any = None,
        calendar_error: BaseException | None = None,
        full_name: str | None = "Alex Fixture",
        display_name: str | None = "fixture-runner",
    ) -> None:
        self._tokens = FakeTokenStore()
        self._activities = activities or []
        self._login_error = login_error
        # What dumps() returns after login, set before login_error is raised (a refresh, then a
        # failed profile load); None keeps the bundle sent.
        self._rotate_to = rotate_to
        self._activities_error = activities_error
        # Raised by get_activities alone, after any activities_error: /sync's newest runs failing
        # while its by-date list worked.
        self._recent_error = recent_error
        # get_activities' answer instead of `activities` (an object where Garmin should answer a
        # list, or another list than get_activities_by_date's); None answers `activities`.
        self._list_answer = list_answer
        # The three detail answers; None serves the fixture files unchanged.
        self._splits = splits
        self._details = details
        self._hr_zones = hr_zones
        # Raised by the first detail call.
        self._detail_error = detail_error
        # Raised by get_activity_details for these activity ids.
        self._details_errors = details_errors or {}
        # get_activity_details' answer for these activity ids, over `details`.
        self._details_answers = details_answers or {}
        # get_personal_record's answer; None serves personal-records.json.
        self._personal_records = personal_records
        # Raised by get_personal_record.
        self._records_error = records_error
        # Raised by the workout write of that name (upload_running_workout, schedule_workout,
        # unschedule_workout, delete_workout) every time it is called.
        self._write_errors = write_errors or {}
        # The upload and schedule answers; None answers a new id each time (1001, 1002, ... and
        # 2001, 2002, ...).
        self._upload_answer = upload_answer
        self._schedule_answer = schedule_answer
        # get_scheduled_workouts' answer; None serves the fake's calendar for the month.
        self._calendar = calendar
        self._calendar_error = calendar_error
        self.uploaded: list[Any] = []
        # The library's retries of a read as connect_real sets them; the calendar read turns them
        # off.
        self.retry_attempts = GARMIN_RETRY_ATTEMPTS
        # retry_attempts as each get_scheduled_workouts call found it.
        self.calendar_retry_attempts: list[int] = []
        self.full_name = full_name
        self.display_name = display_name
        self.calls: list[str] = []

    @property
    def client(self) -> FakeTokenStore:
        return self._tokens

    def login(self, /, tokenstore: str | None = None) -> tuple[str | None, str | None]:
        self.calls.append("login")
        if self._rotate_to is not None:
            self._tokens.bundle = self._rotate_to
        if self._login_error is not None:
            raise self._login_error
        if self._rotate_to is None:
            self._tokens.bundle = tokenstore or ""
        return None, None

    def get_activities_by_date(
        self,
        startdate: str,
        enddate: str | None = None,
        activitytype: str | None = None,
        sortorder: str | None = None,
    ) -> list[dict[str, Any]]:
        self.calls.append(f"get_activities_by_date:{startdate}:{enddate}:{activitytype}")
        if self._activities_error is not None:
            raise self._activities_error
        return self._activities

    def get_activities(
        self,
        start: int = 0,
        limit: int = 20,
        activitytype: str | None = None,
        activitysubtype: str | None = None,
    ) -> dict[str, Any] | list[Any]:
        """Answers `activities` as the page, whatever start and limit say."""
        self.calls.append(f"get_activities:{start}:{limit}:{activitytype}")
        if self._activities_error is not None:
            raise self._activities_error
        if self._recent_error is not None:
            raise self._recent_error
        if self._list_answer is not None:
            answer: dict[str, Any] | list[Any] = self._list_answer
            return answer
        return self._activities

    def get_activity_splits(self, activity_id: str) -> dict[str, Any]:
        self.calls.append(f"get_activity_splits:{activity_id}")
        if self._detail_error is not None:
            raise self._detail_error
        answer: dict[str, Any] = read_fixture("detail-splits.json")
        return answer if self._splits is None else self._splits

    def get_activity_details(
        self, activity_id: str, maxchart: int = 2000, maxpoly: int = 4000
    ) -> dict[str, Any]:
        self.calls.append(f"get_activity_details:{activity_id}:{maxchart}:{maxpoly}")
        if activity_id in self._details_errors:
            raise self._details_errors[activity_id]
        if activity_id in self._details_answers:
            by_id: dict[str, Any] = self._details_answers[activity_id]
            return by_id
        answer: dict[str, Any] = read_fixture("detail-series.json")
        return answer if self._details is None else self._details

    def get_activity_hr_in_timezones(self, activity_id: str) -> dict[str, Any] | list[Any]:
        self.calls.append(f"get_activity_hr_in_timezones:{activity_id}")
        answer: list[Any] = read_fixture("detail-hr-zones.json")
        return answer if self._hr_zones is None else self._hr_zones

    def get_personal_record(self) -> dict[str, Any] | list[Any]:
        self.calls.append("get_personal_record")
        if self._records_error is not None:
            raise self._records_error
        answer: list[Any] = read_fixture("personal-records.json")
        return answer if self._personal_records is None else self._personal_records

    def upload_running_workout(self, workout: Any) -> dict[str, Any]:
        self.calls.append(f"upload_running_workout:{workout.workoutName}")
        self._raise_write_error("upload_running_workout")
        self.uploaded.append(workout)
        if self._upload_answer is not None:
            answer: dict[str, Any] = self._upload_answer
            return answer
        return {"workoutId": 1000 + len(self.uploaded)}

    def schedule_workout(self, workout_id: int | str, date_str: str) -> dict[str, Any]:
        self.calls.append(f"schedule_workout:{workout_id}:{date_str}")
        self._raise_write_error("schedule_workout")
        if self._schedule_answer is not None:
            answer: dict[str, Any] = self._schedule_answer
            return answer
        scheduled = sum(call.startswith("schedule_workout:") for call in self.calls)
        return {"workoutScheduleId": 2000 + scheduled, "calendarDate": date_str}

    def unschedule_workout(self, scheduled_workout_id: int | str) -> Any:
        self.calls.append(f"unschedule_workout:{scheduled_workout_id}")
        self._raise_write_error("unschedule_workout")
        return {}

    def delete_workout(self, workout_id: int | str) -> Any:
        self.calls.append(f"delete_workout:{workout_id}")
        self._raise_write_error("delete_workout")
        return {}

    def get_scheduled_workouts(self, year: int | str, month: int | str) -> dict[str, Any]:
        self.calls.append(f"get_scheduled_workouts:{year}:{month}")
        self.calendar_retry_attempts.append(self.retry_attempts)
        if self._calendar_error is not None:
            raise self._calendar_error
        if self._calendar is not None:
            answer: dict[str, Any] = self._calendar
            return answer
        return FakeGarmin().get_scheduled_workouts(year, month)

    def _raise_write_error(self, name: str) -> None:
        if name in self._write_errors:
            raise self._write_errors[name]

    def connect(self) -> Connect:
        def connect(token_bundle: str) -> GarminSession:
            return login(self, token_bundle, gap_s=0.0)

        return connect


class Clock:
    """A monotonic clock the test moves by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeLogin:
    """Implements PasswordLogin with scripted outcomes and records every call.

    Failures are raised the way garminconnect raises them from a password login.
    """

    def __init__(
        self,
        *,
        needs_mfa: bool = False,
        login_error: BaseException | None = None,
        resume_errors: Sequence[BaseException] = (),
        accepts_code_before_error: bool = False,
        bundle: str = LOGIN_BUNDLE,
        on_resume: Callable[[], None] | None = None,
    ) -> None:
        self._tokens = FakeTokenStore()
        self._tokens.bundle = NO_TOKENS
        self._needs_mfa = needs_mfa
        self._login_error = login_error
        # The n-th resume_login raises the n-th error; calls past the list accept the code.
        self._resume_errors = list(resume_errors)
        # Garmin.resume_login loads the profile after the code is accepted, so it can fail after
        # the tokens are in place.
        self._accepts_code_before_error = accepts_code_before_error
        self._bundle = bundle
        # Runs inside every resume_login, before its outcome: a slow Garmin, for concurrency tests.
        self._on_resume = on_resume
        self.password: str | None = None
        self.calls: list[str] = []
        self.credentials: list[tuple[str, str]] = []
        self.codes: list[str] = []

    @property
    def client(self) -> FakeTokenStore:
        return self._tokens

    def login(self) -> tuple[str | None, Any]:
        self.calls.append("login")
        if self._login_error is not None:
            raise self._login_error
        if self._needs_mfa:
            return "needs_mfa", None
        self._tokens.bundle = self._bundle
        return None, None

    def resume_login(self, client_state: dict[str, Any], mfa_code: str) -> tuple[Any, Any]:
        self.calls.append("resume_login")
        self.codes.append(mfa_code)
        if self._on_resume is not None:
            self._on_resume()
        if self._accepts_code_before_error:
            self._tokens.bundle = self._bundle
        if self._resume_errors:
            raise self._resume_errors.pop(0)
        self._tokens.bundle = self._bundle
        return None, None

    def factory(self) -> GarminFactory:
        """A factory that hands out this one login for every start."""
        return logins_in_order(self)


def logins_in_order(*logins: FakeLogin) -> GarminFactory:
    """A factory that hands out these logins, one per start, recording what each was given."""
    remaining = list(logins)

    def make(email: str, password: str) -> FakeLogin:
        garmin = remaining.pop(0) if len(remaining) > 1 else remaining[0]
        garmin.credentials.append((email, password))
        garmin.password = password
        return garmin

    return make
