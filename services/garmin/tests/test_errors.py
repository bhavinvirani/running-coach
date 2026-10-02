"""errors.py: how garminconnect failures, as the library chains them, map to shared codes."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectNotFoundError,
    GarminConnectTooManyRequestsError,
)

from garmin_service.errors import DEFAULT_RETRY_AFTER_S, from_garmin_exception
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
