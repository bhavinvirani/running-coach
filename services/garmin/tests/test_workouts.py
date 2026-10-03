"""POST /workouts/sync through the real app, with the fixture fake or a scripted Garmin behind it.

Fixture values: workout-calendar.json holds eight workouts other apps scheduled, on days 1, 5, 8,
12, 15, 19, 22 and 26 of whatever month is asked for, and one activity on 2026-09-27. Over
WINDOW (2026-10-26 to 2026-11-01) that is the long run on October 26 and the intervals on
November 1.
"""

from __future__ import annotations

import calendar
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
import requests
from garminconnect import GarminConnectConnectionError, GarminConnectNotFoundError

from garmin_service.fake_client import (
    CALENDAR_FIXTURE,
    FAKE_FIRST_SCHEDULE_ID,
    FAKE_FIRST_WORKOUT_ID,
    FAKE_GONE_SCHEDULE_ID,
    FAKE_GONE_WORKOUT_ID,
    FakeGarmin,
)
from garmin_service.routes import workouts as workouts_route
from tests.conftest import AppFactory
from tests.helpers import (
    BASE_BUNDLE,
    EASY_RUN,
    OURS,
    OURS_SCHEDULE,
    ScriptedGarmin,
    bundle,
    create,
    move,
    read_fixture,
    remove,
    rotated,
    unschedule,
)
from tests.helpers import workout_sync_body as sync_body

PATH = "/workouts/sync"
WINDOW_CALENDAR = [
    {
        "scheduleId": 6_000_000_008,
        "workoutId": 5_000_000_007,
        "date": "2026-10-26",
        "title": "Long Run 8 km",
    },
    {
        "scheduleId": 6_000_000_001,
        "workoutId": 5_000_000_001,
        "date": "2026-11-01",
        "title": "Intervals 6 x 400 m",
    },
]


def post(make_client: AppFactory, body: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    response = make_client(**kwargs).post(PATH, json=body)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def result(
    action: dict[str, Any], outcome: str, workout_id: int | None, schedule_id: int | None
) -> dict[str, Any]:
    return {
        "ref": action["ref"],
        "action": action["action"],
        "outcome": outcome,
        "workoutId": workout_id,
        "scheduleId": schedule_id,
    }


def garmin_down() -> Exception:
    """What get_scheduled_workouts raises once the library's retries on a 503 ran out."""
    error = GarminConnectConnectionError("API call HTTP error")
    error.__cause__ = GarminConnectConnectionError("API Error 503")
    return error


# Success


def test_creates_moves_removes_and_unschedules_in_one_batch_then_reads_the_calendar(
    make_client: AppFactory,
) -> None:
    actions = [create(), move(), remove(), unschedule()]

    body = post(make_client, sync_body(*actions))

    created, moved, removed, unscheduled = body["results"]
    assert created["outcome"] == "done"
    assert created["workoutId"] >= FAKE_FIRST_WORKOUT_ID
    assert created["scheduleId"] >= FAKE_FIRST_SCHEDULE_ID
    assert moved["outcome"] == "done"
    assert moved["workoutId"] == OURS
    assert moved["scheduleId"] >= FAKE_FIRST_SCHEDULE_ID
    assert moved["scheduleId"] not in (OURS_SCHEDULE, created["scheduleId"])
    assert removed == result(actions[2], "done", None, None)
    assert unscheduled == result(actions[3], "done", None, None)
    assert body["stopped"] is None
    assert body["calendar"] == WINDOW_CALENDAR
    assert body["tokenBundle"] == bundle()


def test_calls_garmin_in_order_one_upload_and_schedule_per_create(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    post(make_client, sync_body(create(), move(), remove(), unschedule()), connect=garmin.connect())

    assert garmin.calls == [
        "login",
        "upload_running_workout:Easy Run 5 km",
        "schedule_workout:1001:2026-10-27",
        f"unschedule_workout:{OURS_SCHEDULE}",
        f"schedule_workout:{OURS}:2026-10-28",
        f"unschedule_workout:{OURS_SCHEDULE + 1}",
        f"delete_workout:{OURS + 1}",
        "unschedule_workout:6000000004",
        "get_scheduled_workouts:2026:10",
        "get_scheduled_workouts:2026:11",
    ]


def test_uploads_the_built_running_workout(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin()

    post(make_client, sync_body(create()), connect=garmin.connect())

    [uploaded] = garmin.uploaded
    payload = uploaded.to_dict()
    assert payload["workoutName"] == "Easy Run 5 km"
    assert payload["estimatedDurationInSecs"] == 1800
    [step] = payload["workoutSegments"][0]["workoutSteps"]
    assert step["endCondition"]["conditionTypeKey"] == "distance"
    assert step["endConditionValue"] == 5000.0
    assert step["targetValueOne"] == pytest.approx(1000 / 360)
    assert step["targetValueTwo"] == pytest.approx(1000 / 330)


def test_a_move_without_a_schedule_only_schedules_and_a_remove_without_one_only_deletes(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()
    actions = [move(schedule_id=None), remove(schedule_id=None)]

    body = post(make_client, sync_body(*actions), connect=garmin.connect())

    assert garmin.calls[1:3] == [
        f"schedule_workout:{OURS}:2026-10-28",
        f"delete_workout:{OURS + 1}",
    ]
    assert body["results"] == [
        result(actions[0], "done", OURS, 2001),
        result(actions[1], "done", None, None),
    ]


def test_ids_from_the_fixture_fake_never_repeat_across_requests(make_client: AppFactory) -> None:
    client = make_client()

    first = client.post(PATH, json=sync_body(create(), create("s-2"))).json()["results"]
    second = client.post(PATH, json=sync_body(create())).json()["results"]

    workout_ids = [r["workoutId"] for r in first + second]
    schedule_ids = [r["scheduleId"] for r in first + second]
    assert len(set(workout_ids)) == len(set(schedule_ids)) == 3


def test_an_empty_action_list_still_reads_the_calendar(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin()

    body = post(make_client, sync_body(), connect=garmin.connect())

    assert body == {
        "tokenBundle": bundle(),
        "results": [],
        "stopped": None,
        "calendar": WINDOW_CALENDAR,
    }
    assert garmin.calls == [
        "login",
        "get_scheduled_workouts:2026:10",
        "get_scheduled_workouts:2026:11",
    ]


def test_returns_the_rotated_bundle_with_the_results(make_client: AppFactory) -> None:
    body = post(make_client, sync_body(create(), token_bundle=bundle(fixture="rotate")))

    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}
    assert body["results"][0]["outcome"] == "done"


# Gone on Garmin


def test_a_move_of_a_workout_deleted_on_garmin_answers_gone_with_no_ids(
    make_client: AppFactory,
) -> None:
    action = move(workout_id=FAKE_GONE_WORKOUT_ID)

    body = post(make_client, sync_body(action, create()))

    assert body["results"][0] == result(action, "gone", None, None)
    assert body["results"][1]["outcome"] == "done"
    assert body["stopped"] is None
    assert body["calendar"] == WINDOW_CALENDAR


def test_a_remove_of_a_workout_deleted_on_garmin_is_done(make_client: AppFactory) -> None:
    action = remove(workout_id=FAKE_GONE_WORKOUT_ID)

    body = post(make_client, sync_body(action))

    assert body["results"] == [result(action, "done", None, None)]
    assert body["calendar"] == WINDOW_CALENDAR


def test_an_unschedule_of_a_schedule_deleted_on_garmin_is_done(make_client: AppFactory) -> None:
    action = unschedule(schedule_id=FAKE_GONE_SCHEDULE_ID)

    body = post(make_client, sync_body(action))

    assert body["results"] == [result(action, "done", None, None)]


def test_a_move_or_remove_whose_schedule_was_deleted_on_garmin_goes_on(
    make_client: AppFactory,
) -> None:
    moved = move(schedule_id=FAKE_GONE_SCHEDULE_ID)
    removed = remove(schedule_id=FAKE_GONE_SCHEDULE_ID)

    body = post(make_client, sync_body(moved, removed))

    assert body["results"][0]["outcome"] == "done"
    assert body["results"][0]["workoutId"] == OURS
    assert body["results"][0]["scheduleId"] >= FAKE_FIRST_SCHEDULE_ID
    assert body["results"][1] == result(removed, "done", None, None)


# Stopped batches


def test_workout_outage_keeps_the_first_create_fails_the_second_and_skips_the_rest(
    make_client: AppFactory,
) -> None:
    actions = [create(), create("s-2"), move(), unschedule()]

    body = post(make_client, sync_body(*actions, token_bundle=bundle(fixture="workout_outage")))

    first, second, moved, unscheduled = body["results"]
    assert first["outcome"] == "done"
    assert first["workoutId"] >= FAKE_FIRST_WORKOUT_ID
    assert first["scheduleId"] >= FAKE_FIRST_SCHEDULE_ID
    assert second == result(actions[1], "failed", None, None)
    assert moved == result(actions[2], "skipped", OURS, OURS_SCHEDULE)
    assert unscheduled == result(actions[3], "skipped", None, 6_000_000_004)
    assert body["stopped"] == {"code": "garmin_unavailable"}
    assert body["calendar"] is None


def test_workout_outage_reads_no_calendar_and_makes_no_call_after_the_failure(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(write_errors={"delete_workout": GarminConnectConnectionError("x")})

    post(make_client, sync_body(remove(), move()), connect=garmin.connect())

    assert garmin.calls == [
        "login",
        f"unschedule_workout:{OURS_SCHEDULE + 1}",
        f"delete_workout:{OURS + 1}",
    ]


def test_workout_schedule_outage_answers_the_uploaded_workout_with_no_schedule(
    make_client: AppFactory,
) -> None:
    actions = [create(), remove()]

    body = post(
        make_client, sync_body(*actions, token_bundle=bundle(fixture="workout_schedule_outage"))
    )

    created, removed = body["results"]
    assert created["outcome"] == "failed"
    assert created["workoutId"] >= FAKE_FIRST_WORKOUT_ID
    assert created["scheduleId"] is None
    assert removed == result(actions[1], "skipped", OURS + 1, OURS_SCHEDULE + 1)
    assert body["stopped"] == {"code": "garmin_unavailable"}
    assert body["calendar"] is None


def test_workout_rate_limited_stops_with_the_retry_delay_and_never_retries(
    make_client: AppFactory,
) -> None:
    actions = [create(), create("s-2"), create("s-3")]

    body = post(
        make_client, sync_body(*actions, token_bundle=bundle(fixture="workout_rate_limited"))
    )

    assert [r["outcome"] for r in body["results"]] == ["done", "failed", "skipped"]
    assert body["results"][1] == result(actions[1], "failed", None, None)
    assert body["results"][2] == result(actions[2], "skipped", None, None)
    assert body["stopped"] == {"code": "garmin_rate_limited", "retryAfterSeconds": 3600}
    assert body["calendar"] is None


def test_a_failed_move_after_its_unschedule_answers_the_workout_with_no_schedule(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(write_errors={"schedule_workout": GarminConnectConnectionError("x")})
    action = move()

    body = post(make_client, sync_body(action), connect=garmin.connect())

    assert body["results"] == [result(action, "failed", OURS, None)]


@pytest.mark.parametrize(
    ("failing", "expected_ids"),
    [
        ("unschedule_workout", (OURS + 1, OURS_SCHEDULE + 1)),
        ("delete_workout", (OURS + 1, None)),
    ],
)
def test_a_failed_remove_answers_what_garmin_still_holds(
    make_client: AppFactory, failing: str, expected_ids: tuple[int | None, int | None]
) -> None:
    garmin = ScriptedGarmin(write_errors={failing: GarminConnectConnectionError("API Error 503")})
    action = remove()

    body = post(make_client, sync_body(action), connect=garmin.connect())

    assert body["results"] == [result(action, "failed", *expected_ids)]
    assert body["stopped"] == {"code": "garmin_unavailable"}


def test_a_failed_unschedule_answers_its_schedule_still_held(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin(
        write_errors={"unschedule_workout": GarminConnectConnectionError("API Error 503")}
    )
    action = unschedule()

    body = post(make_client, sync_body(action), connect=garmin.connect())

    assert body["results"] == [result(action, "failed", None, 6_000_000_004)]


def test_a_404_from_a_create_schedule_stops_the_batch(make_client: AppFactory) -> None:
    garmin = ScriptedGarmin(write_errors={"schedule_workout": GarminConnectNotFoundError("x")})

    body = post(make_client, sync_body(create()), connect=garmin.connect())

    assert body["results"] == [result(create(), "failed", 1001, None)]
    assert body["stopped"] == {"code": "not_found"}


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (requests.exceptions.ConnectionError("reset by peer"), "garmin_unavailable"),
        (requests.exceptions.ReadTimeout("read timed out"), "garmin_unavailable"),
        (GarminConnectConnectionError("API Error 401"), "garmin_auth_expired"),
        (GarminConnectConnectionError("API Error 403"), "garmin_unavailable"),
        (GarminConnectConnectionError("API Error 429"), "garmin_rate_limited"),
        (RuntimeError("bug"), "internal"),
    ],
)
def test_maps_the_error_that_stopped_the_batch_like_a_whole_request_failure(
    make_client: AppFactory, error: Exception, code: str
) -> None:
    garmin = ScriptedGarmin(write_errors={"upload_running_workout": error})

    body = post(make_client, sync_body(create(), create("s-2")), connect=garmin.connect())

    assert body["stopped"]["code"] == code
    assert [r["outcome"] for r in body["results"]] == ["failed", "skipped"]


@pytest.mark.parametrize(
    ("garmin", "expected_ids"),
    [
        (ScriptedGarmin(upload_answer={"workoutName": "x"}), (None, None)),
        (ScriptedGarmin(upload_answer={"workoutId": True}), (None, None)),
        (ScriptedGarmin(schedule_answer={"calendarDate": "2026-10-27"}), (1001, None)),
        (ScriptedGarmin(schedule_answer={"workoutScheduleId": "5"}), (1001, None)),
    ],
)
def test_an_unexpected_write_answer_stops_the_batch_as_garmin_unavailable(
    make_client: AppFactory,
    capsys: pytest.CaptureFixture[str],
    garmin: ScriptedGarmin,
    expected_ids: tuple[int | None, int | None],
) -> None:
    body = post(make_client, sync_body(create()), connect=garmin.connect())

    assert body["results"] == [result(create(), "failed", *expected_ids)]
    assert body["stopped"] == {"code": "garmin_unavailable"}
    assert "2026-10-27" not in capsys.readouterr().out


def test_rotate_then_rate_limited_answers_200_with_the_stop_and_the_rotated_bundle(
    make_client: AppFactory,
) -> None:
    body = post(
        make_client, sync_body(create(), token_bundle=bundle(fixture="rotate_then_rate_limited"))
    )

    assert body["results"] == [result(create(), "failed", None, None)]
    assert body["stopped"] == {"code": "garmin_rate_limited", "retryAfterSeconds": 3600}
    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


# Time budget


def clock_jumping_after(calls: int, by: float) -> Any:
    """A clock that stands still for `calls` reads, then has moved on by `by` seconds."""
    reads = 0

    def now() -> float:
        nonlocal reads
        reads += 1
        return 0.0 if reads <= calls else by

    return now


def test_past_the_time_budget_no_action_starts_and_the_rest_are_skipped_without_a_stop(
    make_client: AppFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Reads: the deadline, then before the first action; the second action finds it spent.
    monkeypatch.setattr(workouts_route, "_now", clock_jumping_after(2, by=60.0))
    garmin = ScriptedGarmin()
    actions = [create(), move(), unschedule()]

    body = post(make_client, sync_body(*actions), connect=garmin.connect())

    assert [r["outcome"] for r in body["results"]] == ["done", "skipped", "skipped"]
    assert body["results"][1] == result(actions[1], "skipped", OURS, OURS_SCHEDULE)
    assert body["stopped"] is None
    assert body["calendar"] is None
    assert garmin.calls == [
        "login",
        "upload_running_workout:Easy Run 5 km",
        "schedule_workout:1001:2026-10-27",
    ]


def test_past_the_time_budget_the_calendar_is_not_read(
    make_client: AppFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(workouts_route, "_now", clock_jumping_after(2, by=60.0))
    garmin = ScriptedGarmin()

    body = post(make_client, sync_body(unschedule()), connect=garmin.connect())

    assert body["results"][0]["outcome"] == "done"
    assert (body["stopped"], body["calendar"]) == (None, None)
    assert not any(call.startswith("get_scheduled_workouts") for call in garmin.calls)


def test_the_budget_is_about_40_seconds() -> None:
    assert 30.0 <= workouts_route.WORKOUTS_BUDGET_S <= 45.0


# Calendar


@pytest.mark.parametrize(
    "garmin",
    [
        ScriptedGarmin(calendar_error=garmin_down()),
        ScriptedGarmin(calendar_error=GarminConnectConnectionError("API Error 429")),
        ScriptedGarmin(calendar_error=RuntimeError("bug")),
        ScriptedGarmin(calendar={"items": []}),
        ScriptedGarmin(calendar={"calendarItems": None}),
        ScriptedGarmin(calendar=[{"itemType": "workout"}]),
    ],
)
def test_a_calendar_read_failure_answers_calendar_null_and_never_fails_the_batch(
    make_client: AppFactory, garmin: ScriptedGarmin
) -> None:
    action = remove()

    body = post(make_client, sync_body(action), connect=garmin.connect())

    assert body["results"] == [result(action, "done", None, None)]
    assert body["stopped"] is None
    assert body["calendar"] is None


def test_a_calendar_outage_in_the_fixture_fake_answers_null_with_the_rotated_bundle(
    make_client: AppFactory,
) -> None:
    body = post(make_client, sync_body(token_bundle=bundle(fixture="rotate_then_unavailable")))

    assert body["calendar"] is None
    assert json.loads(body["tokenBundle"]) == {**BASE_BUNDLE, "fixture": "rotated"}


def calendar_item(**fields: Any) -> dict[str, Any]:
    return {
        "id": 61,
        "itemType": "workout",
        "workoutId": 51,
        "date": "2026-10-27",
        "title": "Tempo 2 km",
        **fields,
    }


def test_keeps_only_workouts_with_ids_dated_inside_the_range_sorted_by_date(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin(
        calendar={
            "calendarItems": [
                calendar_item(id=63, date="2026-10-29"),
                calendar_item(id=62, title=None),
                calendar_item(id=61, title=42),
                calendar_item(id=70, itemType="activity"),
                calendar_item(id=71, itemType="event", workoutId=None),
                calendar_item(id=True),
                calendar_item(id=0),
                calendar_item(id="72"),
                calendar_item(id=73, workoutId=None),
                calendar_item(id=74, workoutId=2**53),
                calendar_item(id=75, date="2026-10-25"),
                calendar_item(id=76, date="2026-11-02"),
                calendar_item(id=77, date="2026-10-27T06:00:00"),
                calendar_item(id=78, date="2026-02-30"),
                calendar_item(id=79, date=None),
                "not an item",
            ]
        }
    )
    request = {**sync_body(), "calendarStart": "2026-10-26", "calendarEnd": "2026-10-31"}

    body = post(make_client, request, connect=garmin.connect())

    assert body["calendar"] == [
        {"scheduleId": 61, "workoutId": 51, "date": "2026-10-27", "title": None},
        {"scheduleId": 62, "workoutId": 51, "date": "2026-10-27", "title": None},
        {"scheduleId": 63, "workoutId": 51, "date": "2026-10-29", "title": "Tempo 2 km"},
    ]
    assert garmin.calls[1:] == ["get_scheduled_workouts:2026:10"]


def test_reads_one_month_per_month_the_range_touches_across_a_new_year(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()
    request = {**sync_body(), "calendarStart": "2026-12-29", "calendarEnd": "2027-01-04"}

    body = post(make_client, request, connect=garmin.connect())

    assert garmin.calls[1:] == [
        "get_scheduled_workouts:2026:12",
        "get_scheduled_workouts:2027:1",
    ]
    assert [entry["date"] for entry in body["calendar"]] == ["2027-01-01"]


def test_the_fixture_calendar_holds_a_workout_in_every_7_day_window() -> None:
    fake = FakeGarmin()
    days: set[date] = set()
    for year in (2026, 2027, 2028):
        for month in range(1, 13):
            answer = fake.get_scheduled_workouts(year, month)
            assert (answer["year"], answer["month"]) == (year, month - 1)
            days.update(
                date.fromisoformat(item["date"])
                for item in answer["calendarItems"]
                if item["itemType"] == "workout"
            )
    start = date(2026, 1, 1)
    while start + timedelta(days=6) <= date(2028, 12, 31):
        assert any(start + timedelta(days=n) in days for n in range(7)), start
        start += timedelta(days=1)


def test_the_fake_drops_a_workout_past_the_last_day_of_the_month_asked_for(
    tmp_path: Path,
) -> None:
    answer = read_fixture(CALENDAR_FIXTURE)
    answer["calendarItems"][0]["date"] = "2026-10-31"
    (tmp_path / CALENDAR_FIXTURE).write_text(json.dumps(answer), encoding="utf-8")
    fake = FakeGarmin(tmp_path)

    def workout_dates(year: int, month: int) -> list[str]:
        items = fake.get_scheduled_workouts(year, month)["calendarItems"]
        return [item["date"] for item in items if item["itemType"] == "workout"]

    assert workout_dates(2026, 12)[0] == "2026-12-31"
    assert len(workout_dates(2027, 2)) == len(workout_dates(2026, 12)) - 1
    assert all(int(day[8:]) <= calendar.monthrange(2027, 2)[1] for day in workout_dates(2027, 2))


@pytest.mark.parametrize(("year", "month"), [(2026, 0), (2026, 13), (1999, 5)])
def test_the_fake_rejects_a_month_the_library_rejects(year: int, month: int) -> None:
    with pytest.raises(ValueError, match="no such month"):
        FakeGarmin().get_scheduled_workouts(year, month)


# Login and request failures


def test_returns_401_unauthorized_and_never_calls_garmin_when_the_secret_is_wrong(
    make_client: AppFactory,
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(secret_header="nope", connect=garmin.connect()).post(
        PATH, json=sync_body(create())
    )

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert garmin.calls == []


def test_returns_401_garmin_auth_expired_and_does_nothing_when_the_login_is_expired(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        PATH, json=sync_body(create(), token_bundle=bundle(fixture="expired"))
    )

    assert response.status_code == 401
    assert response.json()["code"] == "garmin_auth_expired"
    assert "results" not in response.json()


def test_returns_429_with_retry_after_when_garmin_rate_limits_the_login(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        PATH, json=sync_body(create(), token_bundle=bundle(fixture="rate_limited"))
    )

    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"
    assert response.json()["retryAfterSeconds"] == 3600


def test_returns_502_garmin_unavailable_when_garmin_is_down_at_login(
    make_client: AppFactory,
) -> None:
    response = make_client().post(
        PATH, json=sync_body(create(), token_bundle=bundle(fixture="unavailable"))
    )

    assert response.status_code == 502
    assert response.json()["code"] == "garmin_unavailable"


@pytest.mark.parametrize(
    "body",
    [
        sync_body(*[create(f"s-{n}") for n in range(9)]),
        sync_body({**create(), "action": "push"}),
        sync_body({**create(), "extra": 1}),
        sync_body({k: v for k, v in move().items() if k != "scheduleId"}),
        sync_body(move(schedule_id=0)),
        sync_body(move(workout_id=2**53)),
        sync_body(unschedule(ref="")),
        sync_body(unschedule(ref="x" * 65)),
        sync_body(create(day="2026-10-32")),
        sync_body({**create(), "workout": {**EASY_RUN, "name": "x" * 61}}),
        sync_body({**create(), "workout": {**EASY_RUN, "steps": []}}),
        {**sync_body(), "calendarStart": "2026-11-02"},
        {k: v for k, v in sync_body().items() if k != "calendarEnd"},
    ],
)
def test_returns_400_validation_for_a_bad_body_and_never_calls_garmin(
    make_client: AppFactory, body: dict[str, Any]
) -> None:
    garmin = ScriptedGarmin()

    response = make_client(connect=garmin.connect()).post(PATH, json=body)

    assert response.status_code == 400
    assert response.json()["code"] == "validation"
    assert "fixture-token" not in response.text
    assert garmin.calls == []


def test_logs_no_workout_names_or_dates(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    post(make_client, sync_body(create(), token_bundle=bundle(fixture="workout_schedule_outage")))
    post(make_client, sync_body(create()))

    logs = capsys.readouterr().out
    assert "workout batch" in logs
    for value in ("Easy Run", "2026-10-27", "Long Run", "fixture-token"):
        assert value not in logs


def test_the_rotated_bundle_from_a_stopped_batch_works_on_the_next_batch(
    make_client: AppFactory,
) -> None:
    client = make_client()
    stopped = client.post(
        PATH, json=sync_body(create(), token_bundle=bundle(fixture="rotate_then_unavailable"))
    ).json()

    retried = client.post(PATH, json=sync_body(create(), token_bundle=stopped["tokenBundle"]))

    assert retried.status_code == 200
    assert retried.json()["results"][0]["outcome"] == "done"
    assert retried.json()["tokenBundle"] == rotated(bundle(fixture="rotate_then_unavailable"))
