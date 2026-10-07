"""errors.py: how garminconnect failures, as the library chains them, map to shared codes."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from types import SimpleNamespace

import pytest
import requests
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectNotFoundError,
    GarminConnectTooManyRequestsError,
)

from garmin_service.errors import (
    DEFAULT_RETRY_AFTER_S,
    from_code_exception,
    from_garmin_exception,
    from_login_exception,
    from_write_exception,
)
from garmin_service.models.problem import ErrorCode
from tests.helpers import (
    VerifyAnswer,
    VerifyOutcome,
    code_refused_answer,
    json_status_answer,
    no_answer,
    non_json_answer,
    timed_out,
    verify_failure,
)


def chained(outer: BaseException, cause: BaseException) -> BaseException:
    outer.__cause__ = cause
    return outer


def profile_load_failure(cause: BaseException) -> BaseException:
    """What Garmin.login() raises when loading the social profile fails three times."""
    return chained(GarminConnectAuthenticationError("Failed to retrieve social profile"), cause)


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (GarminConnectTooManyRequestsError("Rate limit exceeded"), 429, "garmin_rate_limited"),
        (
            profile_load_failure(GarminConnectConnectionError("API Error 429")),
            429,
            "garmin_rate_limited",
        ),
        (
            profile_load_failure(GarminConnectConnectionError("API Error 401")),
            401,
            "garmin_auth_expired",
        ),
        (
            GarminConnectAuthenticationError("Username and password are required"),
            401,
            "garmin_auth_expired",
        ),
        (profile_load_failure(ConnectionError("reset by peer")), 502, "garmin_unavailable"),
        (profile_load_failure(TimeoutError("read timed out")), 502, "garmin_unavailable"),
        (GarminConnectConnectionError("API Error 503 - busy"), 502, "garmin_unavailable"),
        (
            chained(
                GarminConnectConnectionError("API call client error (403): API Error 403"),
                GarminConnectConnectionError("API Error 403"),
            ),
            502,
            "garmin_unavailable",
        ),
        (
            profile_load_failure(GarminConnectConnectionError("API Error 403")),
            502,
            "garmin_unavailable",
        ),
        (GarminConnectNotFoundError("API Error 404"), 404, "not_found"),
        (GarminConnectConnectionError("Login failed: unexpected page"), 502, "garmin_unavailable"),
    ],
)
def test_maps_library_failures_to_shared_codes(exc: BaseException, status: int, code: str) -> None:
    error = from_garmin_exception(exc)

    assert error is not None
    assert (error.status, error.code.value) == (status, code)


def test_uses_3600_seconds_when_garmin_sends_no_retry_after() -> None:
    error = from_garmin_exception(GarminConnectTooManyRequestsError("Rate limit exceeded"))

    assert error is not None
    assert error.retry_after_seconds == DEFAULT_RETRY_AFTER_S == 3600


@pytest.mark.parametrize(("header", "expected"), [("120", 120), ("0", 1), ("999999", 86400)])
def test_uses_garmins_retry_after_header_when_present(header: str, expected: int) -> None:
    cause = GarminConnectConnectionError("API Error 429")
    cause.response = SimpleNamespace(status_code=429, headers={"Retry-After": header})

    error = from_garmin_exception(profile_load_failure(cause))

    assert error is not None
    assert error.code is ErrorCode.GARMIN_RATE_LIMITED
    assert error.retry_after_seconds == expected


def test_returns_none_for_errors_that_are_not_garmin_failures() -> None:
    assert from_garmin_exception(ValueError("bug")) is None
    assert from_garmin_exception(ConnectionError("not from the library")) is None


def test_survives_a_cyclic_exception_chain() -> None:
    outer = GarminConnectAuthenticationError("outer")
    inner = GarminConnectConnectionError("API Error 401")
    outer.__cause__ = inner
    inner.__context__ = outer

    error = from_garmin_exception(outer)

    assert error is not None
    assert error.code is ErrorCode.GARMIN_AUTH_EXPIRED


def strategies_exhausted(last: str) -> BaseException:
    """What Garmin.login() raises when every login strategy failed without a 429 or 401."""
    return chained(
        GarminConnectConnectionError(f"Login failed: All login strategies exhausted: {last}"),
        GarminConnectConnectionError(f"All login strategies exhausted: {last}"),
    )


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        pytest.param(
            GarminConnectAuthenticationError("401 Unauthorized (Invalid Username or Password)"),
            422,
            "garmin_credentials_rejected",
            id="wrong email or password",
        ),
        pytest.param(
            GarminConnectAuthenticationError("Widget authentication failed: 'Account locked'"),
            422,
            "garmin_credentials_rejected",
            id="locked account in the widget flow",
        ),
        pytest.param(
            GarminConnectTooManyRequestsError("All login strategies rate limited (429)."),
            429,
            "garmin_rate_limited",
            id="every strategy answered 429",
        ),
        pytest.param(
            strategies_exhausted("Portal login: CAPTCHA required (bot challenge)"),
            502,
            "garmin_unavailable",
            id="bot challenge on every strategy",
        ),
        pytest.param(
            strategies_exhausted("API Error 404"), 502, "garmin_unavailable", id="a 404 in the text"
        ),
        pytest.param(
            profile_load_failure(requests.exceptions.ConnectionError("reset by peer")),
            502,
            "garmin_unavailable",
            id="network error under a garmin error",
        ),
    ],
)
def test_login_mapping_reads_an_auth_error_as_rejected_credentials(
    exc: BaseException, status: int, code: str
) -> None:
    # A password login has no saved token that could have expired.
    error = from_login_exception(exc)

    assert error is not None
    assert (error.status, error.code.value) == (status, code)


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        pytest.param(
            GarminConnectAuthenticationError("MFA verification failed: ['verifyCode: INVALID']"),
            422,
            "garmin_mfa_rejected",
            id="garmin refused the code",
        ),
        pytest.param(
            GarminConnectAuthenticationError("Widget MFA failed: Enter MFA Code"),
            422,
            "garmin_mfa_rejected",
            id="widget flow refused the code",
        ),
        pytest.param(
            GarminConnectTooManyRequestsError("MFA verification rate limited on all endpoints"),
            429,
            "garmin_rate_limited",
            id="garmin 429 on both verify endpoints",
        ),
        pytest.param(
            requests.exceptions.ConnectionError("reset by peer"),
            502,
            "garmin_unavailable",
            id="bare network error out of resume_login",
        ),
        pytest.param(
            GarminConnectConnectionError("token rejected by API tier after MFA"),
            502,
            "garmin_unavailable",
            id="token rejected after the code",
        ),
    ],
)
def test_code_mapping_reads_an_auth_error_as_a_rejected_code(
    exc: BaseException, status: int, code: str
) -> None:
    error = from_code_exception(exc)

    assert error is not None
    assert (error.status, error.code.value) == (status, code)


# One verify endpoint's outcome, made fresh per test: an exception is raised by the library.
Outcome = Callable[[], VerifyOutcome]


def answer_429() -> VerifyAnswer:
    return VerifyAnswer(429)


def json_429() -> VerifyAnswer:
    return json_status_answer("429")


def cloudflare_403() -> VerifyAnswer:
    return non_json_answer(403)


def error_page_503() -> VerifyAnswer:
    return non_json_answer(503)


def json_503() -> VerifyAnswer:
    return json_status_answer("503")


def json_without_status() -> VerifyAnswer:
    return VerifyAnswer(200, {})


@pytest.mark.parametrize(
    ("outcomes", "status", "code"),
    [
        pytest.param(
            (no_answer, no_answer), 502, "garmin_unavailable", id="connection error on both"
        ),
        pytest.param((timed_out, timed_out), 502, "garmin_unavailable", id="timeout on both"),
        pytest.param(
            (cloudflare_403, cloudflare_403), 502, "garmin_unavailable", id="403 non-JSON on both"
        ),
        pytest.param(
            (error_page_503, error_page_503), 502, "garmin_unavailable", id="503 non-JSON on both"
        ),
        pytest.param(
            (no_answer, cloudflare_403),
            502,
            "garmin_unavailable",
            id="connection error and 403 non-JSON",
        ),
        pytest.param(
            (json_503, json_503), 502, "garmin_unavailable", id="503 in Garmin's JSON on both"
        ),
        pytest.param(
            (answer_429, no_answer), 429, "garmin_rate_limited", id="a 429 and a connection error"
        ),
        pytest.param(
            (code_refused_answer, answer_429),
            429,
            "garmin_rate_limited",
            id="a refusal and a 429",
        ),
        pytest.param(
            (cloudflare_403, json_429),
            429,
            "garmin_rate_limited",
            id="403 non-JSON and a 429 in the JSON body",
        ),
        pytest.param((answer_429, answer_429), 429, "garmin_rate_limited", id="a 429 on both"),
        pytest.param(
            (code_refused_answer, code_refused_answer),
            422,
            "garmin_mfa_rejected",
            id="a refusal on both",
        ),
        pytest.param(
            (code_refused_answer, no_answer),
            422,
            "garmin_mfa_rejected",
            id="a refusal and a connection error",
        ),
        pytest.param(
            (cloudflare_403, code_refused_answer),
            422,
            "garmin_mfa_rejected",
            id="403 non-JSON and a refusal",
        ),
        pytest.param(
            (json_without_status, no_answer),
            422,
            "garmin_mfa_rejected",
            id="JSON without a status and a connection error",
        ),
    ],
)
def test_code_mapping_reads_each_verify_endpoints_outcome_from_the_librarys_message(
    outcomes: Sequence[Outcome], status: int, code: str
) -> None:
    # A refusal on either endpoint is Garmin checking the code: errors._from_verify_failures.
    exc = verify_failure(*(outcome() for outcome in outcomes))

    error = from_code_exception(exc)

    assert error is not None
    assert (error.status, error.code.value) == (status, code)
    if error.code is ErrorCode.GARMIN_RATE_LIMITED:
        assert error.retry_after_seconds == DEFAULT_RETRY_AFTER_S


@pytest.mark.parametrize(
    "message",
    [
        "MFA verification failed: [...]",
        "MFA verification failed: ['unterminated",
        "MFA verification failed: [429, 503]",
        "MFA verification failed: {'a': 'connection error x'}",
    ],
)
def test_code_mapping_reads_a_verify_message_of_another_shape_as_a_refused_code(
    message: str,
) -> None:
    error = from_code_exception(GarminConnectAuthenticationError(message))

    assert error is not None
    assert error.code is ErrorCode.GARMIN_MFA_REJECTED


@pytest.mark.parametrize(
    ("outcomes", "code"),
    [
        pytest.param((no_answer, cloudflare_403), "garmin_unavailable", id="no answer"),
        pytest.param((answer_429, no_answer), "garmin_rate_limited", id="a 429"),
        pytest.param(
            (code_refused_answer, no_answer), "garmin_credentials_rejected", id="a refusal"
        ),
    ],
)
def test_login_mapping_reads_the_verify_outcomes_too_for_the_clis_code_step(
    outcomes: Sequence[Outcome], code: str
) -> None:
    # connect_cli reports a failed code through from_login_exception.
    error = from_login_exception(verify_failure(*(outcome() for outcome in outcomes)))

    assert error is not None
    assert error.code.value == code


@pytest.mark.parametrize(
    "exc",
    [
        pytest.param(requests.exceptions.ConnectionError("reset by peer"), id="requests"),
        pytest.param(requests.exceptions.ReadTimeout("read timed out"), id="requests timeout"),
        pytest.param(TimeoutError("timed out"), id="socket timeout (TimeoutError)"),
        pytest.param(
            chained(RuntimeError("verify failed"), ConnectionError("reset")), id="chained"
        ),
    ],
)
def test_login_mapping_reports_garmin_unavailable_for_a_bare_network_error(
    exc: BaseException,
) -> None:
    # Garmin.resume_login lets these out with no library exception around them.
    error = from_login_exception(exc)

    assert error is not None
    assert (error.status, error.code) == (502, ErrorCode.GARMIN_UNAVAILABLE)


def test_route_mapping_still_ignores_a_bare_network_error() -> None:
    assert from_garmin_exception(requests.exceptions.ConnectionError("reset by peer")) is None
    assert from_garmin_exception(TimeoutError("timed out")) is None


def test_login_mapping_returns_none_for_an_error_that_is_neither_garmin_nor_network() -> None:
    assert from_login_exception(ValueError("bug")) is None
    assert from_login_exception(chained(KeyError("di_token"), ValueError("bug"))) is None
    assert from_code_exception(ValueError("bug")) is None


@pytest.mark.parametrize(
    ("exc", "status", "code", "retry_after"),
    [
        # client.post and client.delete raise these bare, with no API-call wrapper around them.
        (GarminConnectConnectionError("API Error 429"), 429, "garmin_rate_limited", 3600),
        (GarminConnectConnectionError("API Error 503"), 502, "garmin_unavailable", None),
        (GarminConnectConnectionError("API Error 401"), 401, "garmin_auth_expired", None),
        (GarminConnectConnectionError("API Error 400 - bad step"), 502, "garmin_unavailable", None),
        (GarminConnectNotFoundError("API Error 404"), 404, "not_found", None),
        (requests.exceptions.ConnectionError("reset by peer"), 502, "garmin_unavailable", None),
        (requests.exceptions.ReadTimeout("read timed out"), 502, "garmin_unavailable", None),
    ],
)
def test_write_mapping_reads_the_bare_errors_of_the_librarys_post_and_delete(
    exc: BaseException, status: int, code: str, retry_after: int | None
) -> None:
    error = from_write_exception(exc)

    assert error is not None
    assert (error.status, error.code.value, error.retry_after_seconds) == (
        status,
        code,
        retry_after,
    )


def test_write_mapping_returns_none_for_an_error_that_is_neither_garmin_nor_network() -> None:
    assert from_write_exception(ValueError("bug")) is None
    assert from_write_exception(TypeError("workout must be a RunningWorkout instance")) is None
