"""password_login.py: the token check and the pending-MFA check shared by the CLI and /connect."""

from __future__ import annotations

import json
import os

import pytest
import requests
from garminconnect import Garmin, GarminConnectAuthenticationError

from garmin_service.fake_client import FakePasswordLogin
from garmin_service.password_login import (
    code_refused,
    factory_for,
    has_tokens,
    mfa_pending,
    real_garmin,
)
from tests.helpers import LOGIN_BUNDLE, NO_TOKENS, FakeLogin

REFUSED = GarminConnectAuthenticationError("MFA verification failed: [...]")


@pytest.mark.parametrize(
    ("bundle", "expected"),
    [
        (LOGIN_BUNDLE, True),
        (NO_TOKENS, False),
        (json.dumps({"di_token": "a", "di_refresh_token": ""}), False),
        (json.dumps({"di_token": "a"}), False),
        (json.dumps(["a", "b"]), False),
        ("not json", False),
        ("", False),
    ],
)
def test_has_tokens_needs_both_di_tokens(bundle: str, expected: bool) -> None:
    assert has_tokens(bundle) is expected


def test_a_real_garmin_instance_tracks_the_pending_mfa_session_the_check_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Pins garminconnect's private Client._mfa_pending: an upgrade that renames it fails here.
    monkeypatch.delenv("GARMINTOKENS", raising=False)
    garmin = real_garmin("runner@example.com", "not-a-real-password")
    assert isinstance(garmin, Garmin)
    assert garmin.client._mfa_pending is False

    assert mfa_pending(garmin) is False
    garmin.client._mfa_pending = True
    assert mfa_pending(garmin) is True
    # Tokens in place mean Garmin accepted the code; another one cannot work.
    garmin.client.di_token, garmin.client.di_refresh_token = "a", "b"
    assert mfa_pending(garmin) is False


def test_a_login_without_the_library_flag_is_pending_until_it_holds_tokens() -> None:
    garmin = FakeLogin(needs_mfa=True)
    assert mfa_pending(garmin) is True

    garmin.resume_login({}, "123456")

    assert mfa_pending(garmin) is False


def test_code_refused_needs_a_refusal_and_a_login_that_still_waits() -> None:
    waiting = FakeLogin(needs_mfa=True)
    accepted = FakeLogin(needs_mfa=True, accepts_code_before_error=True, resume_errors=[REFUSED])
    with pytest.raises(GarminConnectAuthenticationError):
        accepted.resume_login({}, "123456")

    assert code_refused(waiting, REFUSED) is True
    assert code_refused(accepted, REFUSED) is False
    assert code_refused(waiting, requests.exceptions.ConnectionError("reset")) is False
    assert code_refused(waiting, ValueError("bug")) is False


def test_fixture_mode_uses_the_fake_password_login_and_live_mode_the_library() -> None:
    assert factory_for(fixtures=True) is FakePasswordLogin
    assert factory_for(fixtures=False) is real_garmin


def test_real_garmin_never_reads_garmintokens(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GARMINTOKENS", "/nowhere/tokens")

    garmin = real_garmin("runner@example.com", "not-a-real-password")

    assert "GARMINTOKENS" not in os.environ
    assert isinstance(garmin, Garmin)
    assert garmin.return_on_mfa is True
