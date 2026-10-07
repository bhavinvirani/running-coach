"""errors.py: how garminconnect failures, as the library chains them, map to shared codes."""

from __future__ import annotations

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
