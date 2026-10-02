"""client.py: the call gap, the real-client wiring (no network) and the fixture fake."""

from __future__ import annotations

import json
from typing import Any

import pytest
from garminconnect import Garmin, GarminConnectAuthenticationError

from garmin_service.client import (
    GARMIN_CALL_GAP_S,
    GarminSession,
    connect_fixture,
    connect_real,
    connector_for,
)
from garmin_service.errors import ServiceError
from garmin_service.fake_client import FakeGarmin
from tests.helpers import BASE_BUNDLE, ScriptedGarmin, bundle, rotated


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def test_keeps_the_gap_between_library_calls_but_not_before_the_first() -> None:
    clock = FakeClock()
    session = GarminSession(ScriptedGarmin(), gap_s=1.0, sleep=clock.sleep, clock=clock)

    def work(seconds: float) -> str:
        clock.now += seconds
        return "done"

    assert session.call(work, 0.5) == "done"
    clock.now += 0.25
    session.call(work, 0.1)
    session.call(work, 0.0)

    assert clock.slept == [pytest.approx(0.75), pytest.approx(1.0)]


def test_keeps_the_gap_after_a_call_that_failed() -> None:
    clock = FakeClock()
    session = GarminSession(ScriptedGarmin(), gap_s=1.0, sleep=clock.sleep, clock=clock)

    def fail() -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        session.call(fail)
    session.call(lambda: None)

    assert clock.slept == [pytest.approx(1.0)]


def test_the_gap_constant_is_one_second() -> None:
    assert GARMIN_CALL_GAP_S == 1.0


def test_connect_real_logs_in_with_the_bundle_and_returns_the_librarys_dumps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    def offline_login(self: Garmin, /, tokenstore: str | None = None) -> tuple[None, None]:
        # The real login() loads the tokens the same way before any network call.
        seen["tokenstore"] = tokenstore
        seen["retry_attempts"] = self.retry_attempts
        self.client.loads(tokenstore or "")
        return None, None

    monkeypatch.setattr(Garmin, "login", offline_login)

    session = connect_real(bundle())

    assert seen == {"tokenstore": bundle(), "retry_attempts": 2}
    assert json.loads(session.token_bundle()) == BASE_BUNDLE


@pytest.mark.parametrize("bad", ["~/.garminconnect", "[]", '"text"', "{not json"])
def test_rejects_a_bundle_that_is_not_a_json_object_before_touching_garmin(bad: str) -> None:
    garmin = ScriptedGarmin()

    with pytest.raises(ServiceError) as raised:
        garmin.connect()(bad)

    assert raised.value.code.value == "garmin_auth_expired"
    assert garmin.calls == []


def test_connector_for_picks_the_fake_only_in_fixture_mode() -> None:
    assert connector_for(fixtures=True) is connect_fixture
    assert connector_for(fixtures=False) is connect_real


def test_fake_returns_the_bundle_unchanged_for_unknown_behaviours() -> None:
    sent = bundle(fixture="rotated")
    assert connect_fixture(sent).token_bundle() == sent


def test_fake_rejects_a_bundle_without_tokens_like_the_library() -> None:
    with pytest.raises(GarminConnectAuthenticationError):
        FakeGarmin().login(tokenstore=json.dumps({"fixture": "rotate"}))


def test_fake_lists_oldest_first_when_asked() -> None:
    garmin = FakeGarmin()
    garmin.login(tokenstore=bundle())

    items = garmin.get_activities_by_date("2026-08-31", "2026-09-27", sortorder="asc")

    starts = [item["startTimeLocal"] for item in items]
    assert starts == sorted(starts)


def session_after_login(dumps: str, sent: str = bundle()) -> GarminSession:
    garmin = ScriptedGarmin(rotate_to=dumps)
    garmin.login(tokenstore=sent)
    return GarminSession(garmin, gap_s=0.0, sent_bundle=sent)


def test_rotated_bundle_is_the_new_bundle_when_the_tokens_rotated() -> None:
    new_bundle = rotated(bundle())

    assert session_after_login(new_bundle).rotated_bundle() == new_bundle


def test_rotated_bundle_is_none_when_the_tokens_did_not_change() -> None:
    assert session_after_login(bundle()).rotated_bundle() is None
    # Same tokens, other JSON formatting (Python's dumps adds spaces).
    assert session_after_login(json.dumps(BASE_BUNDLE), sent=bundle()).rotated_bundle() is None


@pytest.mark.parametrize(
    "dumps",
    [
        "",
        "not json",
        "[]",
        json.dumps({"di_token": None, "di_refresh_token": None, "di_client_id": None}),
        json.dumps({**BASE_BUNDLE, "di_refresh_token": ""}),
    ],
)
def test_rotated_bundle_is_none_when_the_tokens_are_missing(dumps: str) -> None:
    assert session_after_login(dumps).rotated_bundle() is None


def test_rotated_bundle_is_none_and_logged_when_dumps_fails(
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Broken:
        def dumps(self) -> str:
            raise RuntimeError("token lock poisoned")

    garmin = ScriptedGarmin()
    session = GarminSession(garmin, gap_s=0.0, sent_bundle=bundle())
    garmin._tokens = Broken()  # type: ignore[assignment]

    assert session.rotated_bundle() is None
    assert "could not read the token bundle" in capsys.readouterr().out
