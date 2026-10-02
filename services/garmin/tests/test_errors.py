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
    from_garmin_exception,
    from_login_exception,
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


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        pytest.param(
            GarminConnectTooManyRequestsError("MFA verification rate limited on all endpoints"),
            "garmin_rate_limited",
            id="garmin 429",
        ),
        pytest.param(
            GarminConnectAuthenticationError("MFA verification failed: [...]"),
            "garmin_auth_expired",
            id="garmin refused the code",
        ),
        pytest.param(
            profile_load_failure(requests.exceptions.ConnectionError("reset by peer")),
            "garmin_unavailable",
            id="network error under a garmin error",
        ),
    ],
)
def test_login_mapping_follows_the_route_mapping_when_the_chain_holds_a_garmin_exception(
    exc: BaseException, code: str
) -> None:
    error = from_login_exception(exc)

    assert error is not None
    assert error.code.value == code
    assert error.code is getattr(from_garmin_exception(exc), "code", None)


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
