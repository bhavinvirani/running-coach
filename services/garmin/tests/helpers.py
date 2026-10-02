"""Shared test data and a scripted Garmin for cases the fixture files do not cover."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from garmin_service.client import Connect, GarminSession, login
from garmin_service.fake_client import FakeTokenStore

TEST_SECRET = "test-secret-not-real"
BASE_BUNDLE: dict[str, str] = {
    "di_token": "fixture-token",
    "di_refresh_token": "fixture-refresh",
    "di_client_id": "fixture-client",
}
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


class ScriptedGarmin:
    """Implements GarminApi with canned answers and records every call."""

    def __init__(
        self,
        *,
        activities: list[dict[str, Any]] | None = None,
        login_error: BaseException | None = None,
        activities_error: BaseException | None = None,
        list_answer: dict[str, Any] | None = None,
        splits: dict[str, Any] | None = None,
        details: dict[str, Any] | None = None,
        hr_zones: dict[str, Any] | list[Any] | None = None,
        detail_error: BaseException | None = None,
        details_errors: dict[str, BaseException] | None = None,
        details_answers: dict[str, Any] | None = None,
        personal_records: Any = None,
        records_error: BaseException | None = None,
        rotate_to: str | None = None,
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
        # An object where get_activities should answer a list; None answers `activities`.
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
        if self._list_answer is not None:
            return self._list_answer
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

    def connect(self) -> Connect:
        def connect(token_bundle: str) -> GarminSession:
            return login(self, token_bundle, gap_s=0.0)

        return connect
