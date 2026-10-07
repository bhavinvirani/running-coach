"""POST /connect and /connect/mfa through the real app, with the fixture password login or a
scripted one (FakeLogin) behind them."""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import httpx
import pytest
import requests
from fastapi.testclient import TestClient
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

from garmin_service.fake_client import (
    FIXTURE_BUNDLE,
    FIXTURE_MFA_CODE,
    FIXTURE_NO_CODE_EMAIL,
    FIXTURE_PASSWORD,
    FIXTURE_RATE_LIMITED_EMAIL,
)
from garmin_service.pending_logins import LOGIN_TTL_S, MAX_CODES
from tests.conftest import AppFactory
from tests.helpers import (
    BASE_BUNDLE,
    LOGIN_BUNDLE,
    NO_TOKENS,
    TEST_SECRET,
    Clock,
    FakeLogin,
    logins_in_order,
)

PROBLEM_JSON = "application/problem+json"
LOGIN_ID = "00000000-0000-4000-8000-000000000001"
OTHER_LOGIN_ID = "00000000-0000-4000-8000-000000000002"
EMAIL = "runner@example.com"
WRONG_PASSWORD = "not-the-fixture-password"
WRONG_CODE = "654321"


def start(
    client: TestClient,
    *,
    email: str = EMAIL,
    password: str = FIXTURE_PASSWORD,
    login_id: str = LOGIN_ID,
) -> httpx.Response:
    # TestClient types its answers as Any here (it imports httpx or httpx2 at runtime).
    response: httpx.Response = client.post(
        "/connect", json={"loginId": login_id, "email": email, "password": password}
    )
    return response


def send_code(
    client: TestClient,
    code: str = FIXTURE_MFA_CODE,
    *,
    login_id: str = LOGIN_ID,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    response: httpx.Response = client.post(
        "/connect/mfa", json={"loginId": login_id, "mfaCode": code}, headers=headers
    )
    return response


def assert_problem(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    assert response.headers["content-type"] == PROBLEM_JSON
    body: dict[str, Any] = response.json()
    assert body["code"] == code
    assert "tokenBundle" not in body
    return body


def scripted(make_client: AppFactory, *logins: FakeLogin, **kwargs: Any) -> TestClient:
    return make_client(password_login=logins_in_order(*logins), **kwargs)


# POST /connect


def test_connect_answers_code_needed_then_the_code_answers_the_fixture_bundle_that_syncs(
    client: TestClient,
) -> None:
    started = start(client)
    connected = send_code(client)

    assert started.status_code == 200
    assert started.json() == {"status": "code_needed"}
    assert connected.status_code == 200
    bundle = connected.json()["tokenBundle"]
    assert bundle == FIXTURE_BUNDLE
    assert json.loads(bundle) == BASE_BUNDLE
    profile = client.post("/profile", json={"tokenBundle": bundle})
    sync = client.post(
        "/sync",
        json={
            "tokenBundle": bundle,
            "startDate": "2026-08-31",
            "endDate": "2026-09-27",
            "recentLimit": 0,
        },
    )
    assert profile.status_code == 200
    assert sync.status_code == 200
    assert sync.json()["activities"]


def test_connect_answers_connected_with_the_bundle_when_garmin_asks_for_no_code(
    client: TestClient,
) -> None:
    response = start(client, email=FIXTURE_NO_CODE_EMAIL)

    assert response.status_code == 200
    assert response.json() == {"status": "connected", "tokenBundle": FIXTURE_BUNDLE}
    # Nothing waits for a code.
    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_connect_answers_connected_without_a_code_through_a_scripted_login(
    make_client: AppFactory,
) -> None:
    garmin = FakeLogin()

    response = start(scripted(make_client, garmin))

    assert response.json() == {"status": "connected", "tokenBundle": LOGIN_BUNDLE}
    assert garmin.calls == ["login"]
    assert garmin.credentials == [(EMAIL, FIXTURE_PASSWORD)]


@pytest.mark.parametrize("secret", [None, "wrong-secret"])
def test_connect_returns_401_and_never_logs_in_when_the_secret_is_wrong(
    make_client: AppFactory, secret: str | None
) -> None:
    garmin = FakeLogin(needs_mfa=True)
    client = make_client(secret_header=secret, password_login=garmin.factory())

    response = start(client)

    assert_problem(response, 401, "unauthorized")
    assert garmin.calls == []
    assert garmin.credentials == []


def test_connect_returns_429_with_retry_after_for_the_fixture_rate_limited_email(
    client: TestClient,
) -> None:
    response = start(client, email=FIXTURE_RATE_LIMITED_EMAIL)

    body = assert_problem(response, 429, "garmin_rate_limited")
    assert body["retryAfterSeconds"] == 3600
    assert response.headers["retry-after"] == "3600"


def test_connect_returns_429_after_one_login_attempt_and_never_retries(
    make_client: AppFactory,
) -> None:
    garmin = FakeLogin(
        login_error=GarminConnectTooManyRequestsError("All login strategies rate limited (429).")
    )
    client = scripted(make_client, garmin)

    response = start(client)

    assert_problem(response, 429, "garmin_rate_limited")
    assert garmin.calls == ["login"]
    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_connect_returns_422_credentials_rejected_for_a_wrong_password(client: TestClient) -> None:
    response = start(client, password=WRONG_PASSWORD)

    assert_problem(response, 422, "garmin_credentials_rejected")
    assert_problem(send_code(client), 409, "garmin_login_lost")


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(
            GarminConnectConnectionError(
                "Login failed: All login strategies exhausted: Portal login: CAPTCHA required"
            ),
            id="every strategy failed",
        ),
        pytest.param(requests.exceptions.ConnectionError("reset by peer"), id="network error"),
    ],
)
def test_connect_returns_502_and_keeps_nothing_when_garmin_is_down(
    make_client: AppFactory, error: BaseException
) -> None:
    client = scripted(make_client, FakeLogin(login_error=error))

    assert_problem(start(client), 502, "garmin_unavailable")
    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_connect_returns_502_without_a_bundle_when_the_login_has_no_di_tokens(
    make_client: AppFactory,
) -> None:
    # The library's web-cookie fallback, when the DI token exchange fails, dumps null tokens.
    response = start(scripted(make_client, FakeLogin(bundle=NO_TOKENS)))

    body = assert_problem(response, 502, "garmin_unavailable")
    assert "token" in body["detail"]


def test_connect_clears_the_password_from_the_login_that_waits_for_a_code(
    make_client: AppFactory,
) -> None:
    garmin = FakeLogin(needs_mfa=True)

    start(scripted(make_client, garmin))

    assert garmin.credentials == [(EMAIL, FIXTURE_PASSWORD)]
    assert garmin.password is None


def test_a_new_start_replaces_the_login_that_waits_for_a_code(make_client: AppFactory) -> None:
    first, second = FakeLogin(needs_mfa=True), FakeLogin(needs_mfa=True)
    client = scripted(make_client, first, second)

    start(client)
    start(client)
    response = send_code(client)

    assert response.status_code == 200
    assert first.codes == []
    assert second.codes == [FIXTURE_MFA_CODE]


def test_a_failed_new_start_drops_the_login_that_waited_for_a_code(client: TestClient) -> None:
    assert start(client).status_code == 200
    assert_problem(start(client, password=WRONG_PASSWORD), 422, "garmin_credentials_rejected")

    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_logins_under_other_ids_wait_side_by_side(client: TestClient) -> None:
    start(client)
    start(client, login_id=OTHER_LOGIN_ID)

    assert send_code(client, login_id=OTHER_LOGIN_ID).status_code == 200
    assert send_code(client).status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"email": EMAIL, "password": FIXTURE_PASSWORD},
        {"loginId": "", "email": EMAIL, "password": FIXTURE_PASSWORD},
        {"loginId": "x" * 129, "email": EMAIL, "password": FIXTURE_PASSWORD},
        {"loginId": LOGIN_ID, "email": "not-an-email", "password": FIXTURE_PASSWORD},
        {"loginId": LOGIN_ID, "email": EMAIL, "password": ""},
        {"loginId": LOGIN_ID, "email": EMAIL, "password": "p" * 257},
        {"loginId": LOGIN_ID, "email": EMAIL, "password": FIXTURE_PASSWORD, "extra": 1},
        {"login_id": LOGIN_ID, "email": EMAIL, "password": FIXTURE_PASSWORD},
        {"loginId": LOGIN_ID, "email": EMAIL, "password": 12345678},
    ],
)
def test_connect_returns_400_validation_without_echoing_the_body_or_logging_in(
    make_client: AppFactory, body: dict[str, Any]
) -> None:
    garmin = FakeLogin(needs_mfa=True)

    response = scripted(make_client, garmin).post("/connect", json=body)

    problem = assert_problem(response, 400, "validation")
    assert problem["issues"]
    assert FIXTURE_PASSWORD not in response.text
    assert EMAIL not in response.text
    assert garmin.calls == []


# POST /connect/mfa


def test_code_returns_409_login_lost_when_no_login_was_started(client: TestClient) -> None:
    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_code_returns_401_and_tries_no_code_when_the_secret_is_wrong(
    make_client: AppFactory,
) -> None:
    garmin = FakeLogin(needs_mfa=True)
    client = scripted(make_client, garmin)
    start(client)

    for secret in ("", "wrong-secret"):
        assert_problem(send_code(client, headers={"x-garmin-secret": secret}), 401, "unauthorized")

    assert garmin.codes == []
    # The login still waits for its code.
    assert send_code(client, headers={"x-garmin-secret": TEST_SECRET}).status_code == 200


def test_a_wrong_code_answers_422_and_the_right_code_then_connects_the_same_login(
    make_client: AppFactory,
) -> None:
    garmin = FakeLogin(
        needs_mfa=True,
        resume_errors=[GarminConnectAuthenticationError("MFA verification failed: [...]")],
    )
    client = scripted(make_client, garmin)
    start(client)

    rejected = send_code(client, WRONG_CODE)
    connected = send_code(client)

    assert_problem(rejected, 422, "garmin_mfa_rejected")
    assert connected.json() == {"tokenBundle": LOGIN_BUNDLE}
    assert garmin.calls == ["login", "resume_login", "resume_login"]
    assert garmin.codes == [WRONG_CODE, FIXTURE_MFA_CODE]


def test_a_wrong_fixture_code_answers_422_and_the_fixture_code_then_connects(
    client: TestClient,
) -> None:
    start(client)

    assert_problem(send_code(client, WRONG_CODE), 422, "garmin_mfa_rejected")
    assert send_code(client).json() == {"tokenBundle": FIXTURE_BUNDLE}
    # The login is done: the code cannot be used twice.
    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_3_wrong_codes_drop_the_login_and_the_third_answers_409_login_lost(
    client: TestClient,
) -> None:
    start(client)

    answers = [send_code(client, WRONG_CODE) for _ in range(MAX_CODES)]

    assert [r.json()["code"] for r in answers] == [
        "garmin_mfa_rejected",
        "garmin_mfa_rejected",
        "garmin_login_lost",
    ]
    assert [r.status_code for r in answers] == [422, 422, 409]
    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_code_returns_409_login_lost_once_5_minutes_passed_since_the_start(
    make_client: AppFactory,
) -> None:
    clock = Clock()
    client = make_client(clock=clock)
    start(client)

    clock.advance(LOGIN_TTL_S - 0.5)
    assert_problem(send_code(client, WRONG_CODE), 422, "garmin_mfa_rejected")
    clock.advance(0.5)

    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_code_returns_409_login_lost_after_a_restart(make_client: AppFactory) -> None:
    assert start(make_client()).status_code == 200

    restarted = make_client()

    assert_problem(send_code(restarted), 409, "garmin_login_lost")


def test_code_returns_429_and_drops_the_login_when_garmin_rate_limits_the_code(
    make_client: AppFactory,
) -> None:
    garmin = FakeLogin(
        needs_mfa=True,
        resume_errors=[
            GarminConnectTooManyRequestsError("MFA verification rate limited on all endpoints")
        ],
    )
    client = scripted(make_client, garmin)
    start(client)

    response = send_code(client)

    body = assert_problem(response, 429, "garmin_rate_limited")
    assert body["retryAfterSeconds"] == 3600
    assert response.headers["retry-after"] == "3600"
    assert_problem(send_code(client), 409, "garmin_login_lost")
    assert garmin.codes == [FIXTURE_MFA_CODE]


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(requests.exceptions.ConnectionError("reset by peer"), id="network error"),
        pytest.param(requests.exceptions.ReadTimeout("read timed out"), id="timeout"),
        pytest.param(GarminConnectConnectionError("API Error 503"), id="garmin 503"),
    ],
)
def test_code_returns_502_and_keeps_the_login_for_the_same_code_when_garmin_is_down(
    make_client: AppFactory, error: BaseException
) -> None:
    garmin = FakeLogin(needs_mfa=True, resume_errors=[error])
    client = scripted(make_client, garmin)
    start(client)

    down = send_code(client)
    connected = send_code(client)

    assert_problem(down, 502, "garmin_unavailable")
    assert connected.json() == {"tokenBundle": LOGIN_BUNDLE}
    assert garmin.calls == ["login", "resume_login", "resume_login"]


def test_an_outage_counts_no_code_against_the_limit(make_client: AppFactory) -> None:
    refused = GarminConnectAuthenticationError("MFA verification failed: [...]")
    down = requests.exceptions.ConnectionError("reset by peer")
    garmin = FakeLogin(needs_mfa=True, resume_errors=[refused, down, refused])
    client = scripted(make_client, garmin)
    start(client)

    statuses = [send_code(client).status_code for _ in range(4)]

    assert statuses == [422, 502, 422, 200]


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(
            GarminConnectAuthenticationError("Invalid user settings found"),
            id="profile load refused",
        ),
        pytest.param(
            GarminConnectAuthenticationError("Failed to retrieve social profile"),
            id="profile load failed",
        ),
    ],
)
def test_code_returns_502_and_drops_the_login_when_it_fails_after_garmin_accepted_the_code(
    make_client: AppFactory, error: BaseException
) -> None:
    # Garmin.resume_login loads the profile once the code is accepted and the MFA session cleared.
    if "social profile" in str(error):
        error.__cause__ = requests.exceptions.ConnectionError("reset by peer")
    garmin = FakeLogin(needs_mfa=True, resume_errors=[error], accepts_code_before_error=True)
    client = scripted(make_client, garmin)
    start(client)

    assert_problem(send_code(client), 502, "garmin_unavailable")
    assert_problem(send_code(client), 409, "garmin_login_lost")
    assert garmin.codes == [FIXTURE_MFA_CODE]


def test_code_returns_502_without_a_bundle_when_the_login_has_no_di_tokens(
    make_client: AppFactory,
) -> None:
    client = scripted(make_client, FakeLogin(needs_mfa=True, bundle=NO_TOKENS))
    start(client)

    body = assert_problem(send_code(client), 502, "garmin_unavailable")
    assert "token" in body["detail"]
    assert_problem(send_code(client), 409, "garmin_login_lost")


def test_code_answers_500_and_drops_the_login_on_an_unexpected_error(
    make_client: AppFactory,
) -> None:
    garmin = FakeLogin(needs_mfa=True, resume_errors=[KeyError("serviceTicketId")])
    client = scripted(make_client, garmin)
    start(client)

    assert_problem(send_code(client), 500, "internal")
    assert_problem(send_code(client), 409, "garmin_login_lost")


@pytest.mark.parametrize(
    "code",
    ["", "123", "12345678901", "12a456", " 123456", "123456\n", "١٢٣٤٥٦", 123456],
)
def test_code_returns_400_for_a_code_that_is_not_4_to_10_digits_and_keeps_the_login(
    make_client: AppFactory, code: object
) -> None:
    garmin = FakeLogin(needs_mfa=True)
    client = scripted(make_client, garmin)
    start(client)

    response = client.post("/connect/mfa", json={"loginId": LOGIN_ID, "mfaCode": code})

    assert_problem(response, 400, "validation")
    assert garmin.codes == []
    assert send_code(client).status_code == 200


def test_two_codes_for_one_login_are_checked_one_at_a_time(make_client: AppFactory) -> None:
    active = 0
    most_active = 0
    lock = threading.Lock()

    def slow_garmin() -> None:
        nonlocal active, most_active
        with lock:
            active += 1
            most_active = max(most_active, active)
        time.sleep(0.2)
        with lock:
            active -= 1

    client = scripted(make_client, FakeLogin(needs_mfa=True, on_resume=slow_garmin))
    start(client)
    statuses: list[int] = []

    def post() -> None:
        statuses.append(send_code(client).status_code)

    threads = [threading.Thread(target=post) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    # The second waited for the first, which finished the login.
    assert most_active == 1
    assert sorted(statuses) == [200, 409]


# Logs


def log_text(capsys: pytest.CaptureFixture[str]) -> str:
    return capsys.readouterr().out


def secrets_in(output: str) -> list[str]:
    secrets = (
        EMAIL,
        FIXTURE_NO_CODE_EMAIL,
        FIXTURE_RATE_LIMITED_EMAIL,
        FIXTURE_PASSWORD,
        WRONG_PASSWORD,
        FIXTURE_MFA_CODE,
        WRONG_CODE,
        "fixture-token",
        "fixture-refresh",
        "login-di-token",
        "login-refresh-token",
    )
    return [secret for secret in secrets if secret in output]


def test_connect_logs_the_login_id_but_never_the_email_password_or_bundle(
    client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    capsys.readouterr()
    start(client, password=WRONG_PASSWORD)
    start(client, email=FIXTURE_RATE_LIMITED_EMAIL)
    start(client, email=FIXTURE_NO_CODE_EMAIL)
    start(client)

    output = log_text(capsys)
    assert secrets_in(output) == []
    assert LOGIN_ID in output
    assert "GarminConnectAuthenticationError" in output
    assert "GarminConnectTooManyRequestsError" in output


def test_code_logs_the_login_id_but_never_the_code_or_bundle(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    client = make_client()
    down = FakeLogin(
        needs_mfa=True,
        resume_errors=[requests.exceptions.ConnectionError(f"reset {FIXTURE_MFA_CODE}")],
    )
    scripted_client = scripted(make_client, down)
    start(client)
    start(scripted_client)
    capsys.readouterr()

    send_code(client, WRONG_CODE)
    send_code(client)
    send_code(client)
    send_code(scripted_client)
    send_code(scripted_client)

    output = log_text(capsys)
    assert secrets_in(output) == []
    assert LOGIN_ID in output
    assert "garmin_mfa_rejected" in output
    assert "garmin_login_lost" in output
    assert "ConnectionError" in output


def test_logs_no_secret_from_a_library_message_on_an_unexpected_error(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = FakeLogin(
        needs_mfa=True,
        resume_errors=[RuntimeError(f"{EMAIL} {FIXTURE_PASSWORD} {FIXTURE_MFA_CODE}")],
    )
    client = scripted(make_client, garmin)
    start(client)
    capsys.readouterr()

    send_code(client)

    output = log_text(capsys)
    assert secrets_in(output) == []
    assert "RuntimeError" in output
