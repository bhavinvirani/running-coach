"""Fixture mode (GARMIN_FIXTURES=1): a fake Garmin serving tests/fixtures/*.json, no network.

One fake account: profile.json is the runner; the activities are sync.json (the latest weeks) plus
history.json (hand-made fake years before them, with non-runs mixed in).
Both list calls serve that union newest first and ignore the activity type, so the routes' own run
filter must hold by itself.

The three detail calls serve detail-splits.json, detail-series.json and detail-hr-zones.json (one
real run, sanitized and trimmed) for any activity of the account, with its id patched in, and
derive the variants from the account's list item: an indoor type has no route and no elevation, a
run without heart rate has no HR series, no lap HR and no second in any zone, a manual entry has no
laps, no samples and no zones. An outdoor run gets a fictional loop around 0.0, -30.0 (open
ocean) as its route, since the sanitizer removes the real one; with maxpoly 0 its polyline is
empty, as Garmin answers. An id outside the account is a 404, as Garmin answers (the series route
reports it "gone"), except FAKE_UNAVAILABLE_ACTIVITY_IDS: every per-run call for them fails the
way garminconnect raises a 503 once its retries ran out, so the API's tests reach the series route's
per-run "failed" (and the detail route's 502) on one run while the others succeed, and with both in
a row its early stop, which answers the runs after them "skipped". The series route asks for the
same details at maxchart 10000 and gets the same fixture rows; a manual entry answers with no rows
("ok", empty).

get_personal_record serves personal-records.json: made-up values in the shape captured from Garmin
(distance records 1 to 5, the longest run 7, step and goal records 12 to 16).

The workout calls serve workout-upload.json and workout-schedule.json (spike 2's captures) with
fresh ids from per-process counters (workouts from FAKE_FIRST_WORKOUT_ID, schedules from
FAKE_FIRST_SCHEDULE_ID), so ids never repeat across requests while the fake keeps no other state:
nothing uploaded shows on its calendar. Unschedule and delete answer {}, as the library does on 204.
get_scheduled_workouts serves workout-calendar.json (other apps' workouts on days 1 to 26, and one
activity) with every workout moved into the month asked for, same day of the month, so any 7-day
window holds some, across a month's end too. FAKE_GONE_WORKOUT_ID answers 404 to schedule and
delete, FAKE_GONE_SCHEDULE_ID to unschedule: deleted in Garmin Connect.

The token bundle drives the behaviour, so the API's integration tests and e2e reach every path
through the real service. Base bundle:
    {"di_token":"fixture-token","di_refresh_token":"fixture-refresh","di_client_id":"fixture-client"}
Add "fixture": "expired" (401 garmin_auth_expired), "rate_limited" (429), "unavailable" (502), or
"rotate" (success, and the returned bundle carries "fixture": "rotated").
"rotate_then_rate_limited" and "rotate_then_unavailable" rotate like "rotate" at login, then fail
the next library call with a 429 or a 502 whose problem carries the rotated bundle (/profile makes
no further call, so it succeeds; /workouts/sync answers 200 with the stop and the rotated bundle).
"workout_outage" fails the second upload of a request with a 503 before it uploads, so the first
create completes; "workout_rate_limited" does the same with a 429; "workout_schedule_outage" fails
every schedule with a 503, so a create uploads and stops halfway. Writes fail the way the library's
client.post and client.delete raise, with no retries and no wrapper.
Anything else succeeds with the bundle unchanged. Failures are raised the way garminconnect raises
them, causes chained, so errors.py runs exactly as in production.
"""

from __future__ import annotations

import calendar
import itertools
import json
import math
from pathlib import Path
from typing import Any, Literal

from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectNotFoundError,
    GarminConnectTooManyRequestsError,
)
from garminconnect.workout import RunningWorkout

from garmin_service.activities import INDOOR_TYPE_KEYS

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
ACTIVITY_FIXTURES = ("sync.json", "history.json")
SPLITS_FIXTURE = "detail-splits.json"
SERIES_FIXTURE = "detail-series.json"
HR_ZONES_FIXTURE = "detail-hr-zones.json"
RECORDS_FIXTURE = "personal-records.json"
UPLOAD_FIXTURE = "workout-upload.json"
SCHEDULE_FIXTURE = "workout-schedule.json"
CALENDAR_FIXTURE = "workout-calendar.json"
FAKE_FIRST_WORKOUT_ID = 900_000_001
FAKE_FIRST_SCHEDULE_ID = 800_000_001
# Deleted in Garmin Connect: a 404 from schedule and delete, or from unschedule.
FAKE_GONE_WORKOUT_ID = 404_404
FAKE_GONE_SCHEDULE_ID = 404_405
# Per process, not per request: the API's tests see a new id for every upload and schedule.
_workout_ids = itertools.count(FAKE_FIRST_WORKOUT_ID)
_schedule_ids = itertools.count(FAKE_FIRST_SCHEDULE_ID)
# The fictional route: a loop in open ocean, far from anyone's real runs.
FAKE_ROUTE_CENTER = (0.0, -30.0)
FAKE_ROUTE_RADIUS_DEG = 0.02
FAKE_ROUTE_POINTS = 120
# No activity of the account has these ids: Garmin down for these runs alone.
FAKE_UNAVAILABLE_ACTIVITY_ID = 9_000_000_503
FAKE_UNAVAILABLE_ACTIVITY_IDS = frozenset({FAKE_UNAVAILABLE_ACTIVITY_ID, 9_000_000_504})

# What garminconnect's _run_request raises underneath login() for each simulated failure.
_LOGIN_FAILURES = {
    "expired": "API Error 401",
    "rate_limited": "API Error 429",
    "unavailable": "API Error 503",
}
_ROTATE_THEN_FAIL = frozenset({"rotate_then_rate_limited", "rotate_then_unavailable"})


def _call_failure(status: Literal[429, 503]) -> Exception:
    """What garminconnect's API-call wrapper raises for a 429, or a 503 once its retries ran out."""
    if status == 429:
        error: Exception = GarminConnectTooManyRequestsError("Rate limit exceeded")
        cause = GarminConnectConnectionError("API Error 429")
    else:
        error = GarminConnectConnectionError("API call HTTP error")
        cause = GarminConnectConnectionError("API Error 503")
    error.__cause__ = cause
    return error


def _not_found() -> Exception:
    """What garminconnect's API-call wrapper raises when Garmin answers 404 for an unknown id."""
    error = GarminConnectNotFoundError("API call client error (404): API Error 404")
    error.__cause__ = GarminConnectNotFoundError("API Error 404")
    return error


def _write_failure(status: Literal[404, 429, 503]) -> Exception:
    """What the library's client.post and client.delete raise: no wrapper, no retries."""
    if status == 404:
        return GarminConnectNotFoundError("API Error 404")
    return GarminConnectConnectionError(f"API Error {status}")


def _drop_metric(details: dict[str, Any], key: str) -> None:
    """Leave one series out the way Garmin does: no descriptor and no column in any row."""
    descriptors = details["metricDescriptors"]
    index = next((d["metricsIndex"] for d in descriptors if d["key"] == key), None)
    if index is None:
        return
    kept = []
    for d in descriptors:
        if d["key"] != key:
            column = d["metricsIndex"]
            kept.append({**d, "metricsIndex": column - 1 if column > index else column})
    details["metricDescriptors"] = kept
    for row in details["activityDetailMetrics"]:
        del row["metrics"][index]
    details["measurementCount"] = len(details["metricDescriptors"])


def _fake_route() -> dict[str, Any]:
    lat0, lon0 = FAKE_ROUTE_CENTER
    points = []
    for i in range(FAKE_ROUTE_POINTS + 1):  # the last point closes the loop
        angle = 2 * math.pi * i / FAKE_ROUTE_POINTS
        points.append(
            {
                "lat": round(lat0 + FAKE_ROUTE_RADIUS_DEG * math.sin(angle), 6),
                "lon": round(lon0 + FAKE_ROUTE_RADIUS_DEG * math.cos(angle), 6),
                "valid": True,
            }
        )
    return {"polyline": points}


class FakeTokenStore:
    def __init__(self) -> None:
        self.bundle = ""

    def dumps(self) -> str:
        return self.bundle


class FakeGarmin:
    def __init__(self, fixtures_dir: Path = FIXTURES_DIR) -> None:
        self._fixtures_dir = fixtures_dir
        self._tokens = FakeTokenStore()
        # GarminApi's retry knob: no network behind the fake, so nothing reads it.
        self.retry_attempts = 0
        self.display_name: str | None = None
        self.full_name: str | None = None
        self._fail_next_call: str | None = None
        self._behaviour: str | None = None
        self._uploads = 0

    @property
    def client(self) -> FakeTokenStore:
        return self._tokens

    def login(self, /, tokenstore: str | None = None) -> tuple[str | None, str | None]:
        try:
            bundle = json.loads(tokenstore or "")
        except ValueError:
            bundle = None
        if not isinstance(bundle, dict) or not bundle.get("di_token"):
            # garminconnect's answer when the tokens do not load and there is no password.
            raise GarminConnectAuthenticationError("Username and password are required")

        behaviour = bundle.get("fixture")
        self._behaviour = behaviour if isinstance(behaviour, str) else None
        if isinstance(behaviour, str) and behaviour in _LOGIN_FAILURES:
            raise GarminConnectAuthenticationError(
                "Failed to retrieve social profile"
            ) from GarminConnectConnectionError(_LOGIN_FAILURES[behaviour])

        if behaviour == "rotate" or behaviour in _ROTATE_THEN_FAIL:
            self._tokens.bundle = json.dumps({**bundle, "fixture": "rotated"})
            if behaviour in _ROTATE_THEN_FAIL:
                self._fail_next_call = behaviour
        else:
            self._tokens.bundle = tokenstore or ""

        profile = self._read("profile.json")
        if not isinstance(profile, dict):
            raise TypeError("profile.json must hold an object")
        self.display_name = profile.get("displayName")
        self.full_name = profile.get("fullName")
        return None, None

    def get_activities_by_date(
        self,
        startdate: str,
        enddate: str | None = None,
        activitytype: str | None = None,
        sortorder: str | None = None,
    ) -> list[dict[str, Any]]:
        self._fail_pending_call()
        last = enddate or "9999-12-31"
        selected = [
            item
            for item in self._account()
            if startdate <= str(item["startTimeLocal"])[:10] <= last
        ]
        if sortorder == "asc":
            selected.reverse()
        return selected

    def get_activities(
        self,
        start: int = 0,
        limit: int = 20,
        activitytype: str | None = None,
        activitysubtype: str | None = None,
    ) -> list[dict[str, Any]]:
        self._fail_pending_call()
        return self._account()[start : start + limit]

    def get_activity_splits(self, activity_id: str) -> dict[str, Any]:
        self._fail_pending_call()
        item = self._activity(activity_id)
        splits: dict[str, Any] = self._read(SPLITS_FIXTURE)
        splits["activityId"] = item["activityId"]
        if item.get("manualActivity"):
            splits["lapDTOs"] = []
        elif not item.get("averageHR"):
            for lap in splits["lapDTOs"]:
                lap.pop("averageHR", None)
                lap.pop("maxHR", None)
        return splits

    def get_activity_details(
        self, activity_id: str, maxchart: int = 2000, maxpoly: int = 4000
    ) -> dict[str, Any]:
        self._fail_pending_call()
        item = self._activity(activity_id)
        details: dict[str, Any] = self._read(SERIES_FIXTURE)
        details["activityId"] = item["activityId"]
        if item.get("manualActivity"):
            details.update(
                measurementCount=0,
                metricsCount=0,
                metricDescriptors=[],
                activityDetailMetrics=[],
                detailsAvailable=False,
            )
            return details
        if not item.get("averageHR"):
            _drop_metric(details, "directHeartRate")
        if item["activityType"]["typeKey"] in INDOOR_TYPE_KEYS:
            _drop_metric(details, "directElevation")
        else:
            details["geoPolylineDTO"] = _fake_route() if maxpoly > 0 else {"polyline": []}
        return details

    def get_activity_hr_in_timezones(self, activity_id: str) -> list[dict[str, Any]]:
        self._fail_pending_call()
        item = self._activity(activity_id)
        zones: list[dict[str, Any]] = self._read(HR_ZONES_FIXTURE)
        if item.get("manualActivity") or not item.get("averageHR"):
            zones = [{**zone, "secsInZone": 0.0} for zone in zones]
        return zones

    def get_personal_record(self) -> list[dict[str, Any]]:
        self._fail_pending_call()
        records: list[dict[str, Any]] = self._read(RECORDS_FIXTURE)
        return records

    def upload_running_workout(self, workout: Any) -> dict[str, Any]:
        self._fail_pending_call()
        if not isinstance(workout, RunningWorkout):
            raise TypeError("workout must be a RunningWorkout instance")
        self._uploads += 1
        if self._uploads == 2 and self._behaviour == "workout_outage":
            raise _write_failure(503)
        if self._uploads == 2 and self._behaviour == "workout_rate_limited":
            raise _write_failure(429)
        uploaded: dict[str, Any] = self._read(UPLOAD_FIXTURE)
        uploaded.update(
            workoutId=next(_workout_ids),
            workoutName=workout.workoutName,
            estimatedDurationInSecs=workout.estimatedDurationInSecs,
        )
        return uploaded

    def schedule_workout(self, workout_id: int | str, date_str: str) -> dict[str, Any]:
        self._fail_pending_call()
        if self._behaviour == "workout_schedule_outage":
            raise _write_failure(503)
        if int(workout_id) == FAKE_GONE_WORKOUT_ID:
            raise _write_failure(404)
        scheduled: dict[str, Any] = self._read(SCHEDULE_FIXTURE)
        scheduled.update(workoutScheduleId=next(_schedule_ids), calendarDate=date_str)
        scheduled["workout"]["workoutId"] = int(workout_id)
        return scheduled

    def unschedule_workout(self, scheduled_workout_id: int | str) -> dict[str, Any]:
        self._fail_pending_call()
        if int(scheduled_workout_id) == FAKE_GONE_SCHEDULE_ID:
            raise _write_failure(404)
        return {}

    def delete_workout(self, workout_id: int | str) -> dict[str, Any]:
        self._fail_pending_call()
        if int(workout_id) == FAKE_GONE_WORKOUT_ID:
            raise _write_failure(404)
        return {}

    def get_scheduled_workouts(self, year: int | str, month: int | str) -> dict[str, Any]:
        self._fail_pending_call()
        year, month = int(year), int(month)
        # The library's own checks: a 0-based month here would be a bug in the route.
        if year < 2000 or not 1 <= month <= 12:
            raise ValueError(f"no such month: {year}-{month}")
        answer: dict[str, Any] = self._read(CALENDAR_FIXTURE)
        last_day = calendar.monthrange(year, month)[1]
        items = []
        for item in answer["calendarItems"]:
            if item.get("itemType") == "workout":
                day = int(str(item["date"])[8:10])
                if day > last_day:
                    continue
                item = {**item, "date": f"{year:04d}-{month:02d}-{day:02d}"}
            items.append(item)
        # Garmin answers the 0-based month it was sent.
        answer.update(year=year, month=month - 1, calendarItems=items)
        return answer

    def _activity(self, activity_id: str) -> dict[str, Any]:
        if activity_id in {str(unavailable) for unavailable in FAKE_UNAVAILABLE_ACTIVITY_IDS}:
            raise _call_failure(503)
        for item in self._account():
            if str(item["activityId"]) == activity_id:
                return item
        raise _not_found()

    def _fail_pending_call(self) -> None:
        if self._fail_next_call is not None:
            behaviour, self._fail_next_call = self._fail_next_call, None
            raise _call_failure(429 if behaviour == "rotate_then_rate_limited" else 503)

    def _account(self) -> list[dict[str, Any]]:
        """Every activity of the fake account, newest first by startTimeLocal like Garmin."""
        items: list[dict[str, Any]] = []
        for name in ACTIVITY_FIXTURES:
            listed = self._read(name)
            if not isinstance(listed, list):
                raise TypeError(f"{name} must hold a list")
            items.extend(item for item in listed if isinstance(item, dict))
        items.sort(key=lambda item: str(item["startTimeLocal"]), reverse=True)
        return items

    def _read(self, name: str) -> Any:
        return json.loads((self._fixtures_dir / name).read_text(encoding="utf-8"))
