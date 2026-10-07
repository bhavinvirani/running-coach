"""pending_logins.py: one login per id, 5 min from the start, one code at a time per login."""

from __future__ import annotations

import threading

import pytest

from garmin_service.errors import ServiceError
from garmin_service.pending_logins import LOGIN_TTL_S, PendingLogins
from tests.helpers import Clock, FakeLogin

LOGIN_ID = "login-1"


def assert_lost(logins: PendingLogins, login_id: str = LOGIN_ID) -> None:
    with pytest.raises(ServiceError) as raised, logins.checkout(login_id):
        pass
    assert (raised.value.status, raised.value.code.value) == (409, "garmin_login_lost")


def test_checkout_hands_out_the_login_kept_under_its_id() -> None:
    logins = PendingLogins()
    garmin = FakeLogin(needs_mfa=True)
    logins.put(LOGIN_ID, garmin)

    with logins.checkout(LOGIN_ID) as pending:
        assert pending.garmin is garmin
        assert pending.refused_codes == 0
    assert_lost(logins, "another-id")


def test_a_new_put_replaces_the_login_under_the_same_id() -> None:
    logins = PendingLogins()
    second = FakeLogin(needs_mfa=True)
    logins.put(LOGIN_ID, FakeLogin(needs_mfa=True))
    logins.put(LOGIN_ID, second)

    with logins.checkout(LOGIN_ID) as pending:
        assert pending.garmin is second
    assert len(logins) == 1


def test_a_login_expires_5_minutes_after_its_start_and_is_swept() -> None:
    clock = Clock()
    logins = PendingLogins(clock=clock)
    logins.put(LOGIN_ID, FakeLogin(needs_mfa=True))
    logins.put("other", FakeLogin(needs_mfa=True))

    clock.advance(LOGIN_TTL_S - 0.001)
    assert len(logins) == 2
    clock.advance(0.001)

    assert len(logins) == 0
    assert_lost(logins)


def test_drop_forgets_only_the_login_it_was_given() -> None:
    logins = PendingLogins()
    logins.put(LOGIN_ID, FakeLogin(needs_mfa=True))
    with logins.checkout(LOGIN_ID) as old:
        pass
    logins.put(LOGIN_ID, FakeLogin(needs_mfa=True))

    logins.drop(LOGIN_ID, old)
    assert len(logins) == 1
    logins.discard(LOGIN_ID)
    assert len(logins) == 0


def test_a_second_code_waits_for_the_first_and_finds_the_login_gone_when_it_finished() -> None:
    logins = PendingLogins()
    logins.put(LOGIN_ID, FakeLogin(needs_mfa=True))
    first_holds = threading.Event()
    release_first = threading.Event()
    second_outcome: list[str] = []

    def first() -> None:
        with logins.checkout(LOGIN_ID) as pending:
            first_holds.set()
            release_first.wait(timeout=5)
            logins.drop(LOGIN_ID, pending)

    def second() -> None:
        try:
            with logins.checkout(LOGIN_ID):
                second_outcome.append("checked out")
        except ServiceError as error:
            second_outcome.append(error.code.value)

    one = threading.Thread(target=first)
    one.start()
    assert first_holds.wait(timeout=5)
    two = threading.Thread(target=second)
    two.start()
    two.join(timeout=0.2)
    assert two.is_alive()  # waiting on the login's lock, not answering
    release_first.set()
    one.join(timeout=5)
    two.join(timeout=5)

    assert second_outcome == ["garmin_login_lost"]


def test_a_code_waiting_on_a_login_that_a_new_start_replaced_finds_it_lost() -> None:
    logins = PendingLogins()
    logins.put(LOGIN_ID, FakeLogin(needs_mfa=True))
    outcome: list[str] = []

    with logins.checkout(LOGIN_ID):

        def waiting_code() -> None:
            try:
                with logins.checkout(LOGIN_ID):
                    outcome.append("checked out")
            except ServiceError as error:
                outcome.append(error.code.value)

        waiter = threading.Thread(target=waiting_code)
        waiter.start()
        waiter.join(timeout=0.2)
        # A new start does not wait for the code in progress.
        logins.put(LOGIN_ID, FakeLogin(needs_mfa=True))
    waiter.join(timeout=5)

    assert outcome == ["garmin_login_lost"]
    assert len(logins) == 1
