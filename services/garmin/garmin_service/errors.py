"""The one place exceptions become problem+json with the shared error codes.

garminconnect wraps errors in layers, so the class alone is misleading: login() turns a 429 or a
network failure while loading the profile into GarminConnectAuthenticationError, with the real
cause chained underneath as "API Error 429" or a requests ConnectionError. The mapping therefore
walks the whole __cause__/__context__ chain and lets an HTTP status found there win over the
outer class. The connection is reported expired only on a 401 or an auth error with no other
explanation: a false "expired" makes the runner log in again, which Garmin rate-limits hard.
"""

from __future__ import annotations

import logging
import re
import traceback
from collections.abc import Iterator, Sequence
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectNotFoundError,
    GarminConnectTooManyRequestsError,
)
from starlette.exceptions import HTTPException as StarletteHTTPException

from garmin_service.log import request_id_var
from garmin_service.models.problem import ErrorCode, Issue, Problem

log = logging.getLogger(__name__)

PROBLEM_MEDIA_TYPE = "application/problem+json"
# Garmin rarely sends Retry-After, and its blocks last about an hour.
DEFAULT_RETRY_AFTER_S = 3600
MAX_RETRY_AFTER_S = 24 * 3600

# The library's own formats: "API Error 429 - ..." from the HTTP layer, "... client error (403)".
_STATUS_IN_MESSAGE = re.compile(r"(?:API Error|client error \()\s*(\d{3})")

_GARMIN_EXCEPTIONS: tuple[type[Exception], ...] = (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)


class ServiceError(Exception):
    """An expected failure with its HTTP status and shared code. Raised by routes and the client."""

    def __init__(
        self,
        status: int,
        code: ErrorCode,
        detail: str,
        *,
        retry_after_seconds: int | None = None,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.retry_after_seconds = retry_after_seconds


def auth_expired() -> ServiceError:
    return ServiceError(
        401, ErrorCode.GARMIN_AUTH_EXPIRED, "Garmin rejected the saved login. Connect Garmin again."
    )


def rate_limited(retry_after_seconds: int = DEFAULT_RETRY_AFTER_S) -> ServiceError:
    return ServiceError(
        429,
        ErrorCode.GARMIN_RATE_LIMITED,
        "Garmin is limiting requests. Try again later.",
        retry_after_seconds=retry_after_seconds,
    )


def unavailable() -> ServiceError:
    return ServiceError(
        502, ErrorCode.GARMIN_UNAVAILABLE, "Garmin did not answer as expected. Try again later."
    )


def not_found() -> ServiceError:
    return ServiceError(404, ErrorCode.NOT_FOUND, "Garmin has no such item.")


def _chain(exc: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _status_of(exc: BaseException) -> int | None:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status, int):
        return status
    match = _STATUS_IN_MESSAGE.search(str(exc))
    return int(match.group(1)) if match else None


def _retry_after(chain: list[BaseException]) -> int:
    for exc in chain:
        headers = getattr(getattr(exc, "response", None), "headers", None)
        value = headers.get("Retry-After") if headers is not None else None
        if isinstance(value, str) and value.strip().isdigit():
            return min(max(int(value.strip()), 1), MAX_RETRY_AFTER_S)
    return DEFAULT_RETRY_AFTER_S


def from_garmin_exception(exc: BaseException) -> ServiceError | None:
    """Map a garminconnect failure to a ServiceError; None when it is not a Garmin failure."""
    chain = list(_chain(exc))
    if not any(isinstance(e, _GARMIN_EXCEPTIONS) for e in chain):
        return None
    statuses = {s for e in chain if (s := _status_of(e)) is not None}

    if 429 in statuses or any(isinstance(e, GarminConnectTooManyRequestsError) for e in chain):
        return rate_limited(_retry_after(chain))
    # requests' ConnectionError and Timeout derive from OSError, as do socket errors.
    if any(500 <= s < 600 for s in statuses) or any(isinstance(e, OSError) for e in chain):
        return unavailable()
    if 401 in statuses:
        return auth_expired()
    if 404 in statuses or any(isinstance(e, GarminConnectNotFoundError) for e in chain):
        return not_found()
    if statuses:
        # 403 and other 4xx: in practice a Cloudflare or IP block, not a dead token.
        return unavailable()
    if any(isinstance(e, GarminConnectAuthenticationError) for e in chain):
        return auth_expired()
    return unavailable()


def make_problem(
    status: int,
    code: ErrorCode,
    detail: str | None = None,
    *,
    retry_after_seconds: int | None = None,
    issues: list[Issue] | None = None,
) -> Problem:
    return Problem(
        title=HTTPStatus(status).phrase,
        status=status,
        code=code,
        detail=detail,
        request_id=request_id_var.get(),
        retry_after_seconds=retry_after_seconds,
        issues=issues,
    )


def problem_response(problem: Problem) -> JSONResponse:
    headers = {}
    if problem.retry_after_seconds is not None:
        headers["Retry-After"] = str(problem.retry_after_seconds)
    return JSONResponse(
        problem.model_dump(mode="json", exclude_none=True),
        status_code=problem.status,
        media_type=PROBLEM_MEDIA_TYPE,
        headers=headers,
    )


def error_response(error: ServiceError) -> JSONResponse:
    return problem_response(
        make_problem(
            error.status,
            error.code,
            error.detail,
            retry_after_seconds=error.retry_after_seconds,
        )
    )


def unauthorized_response() -> JSONResponse:
    return problem_response(
        make_problem(401, ErrorCode.UNAUTHORIZED, "Missing or wrong x-garmin-secret header.")
    )


def internal_error_response(exc: BaseException) -> JSONResponse:
    """Log the class and stack frames only (messages can quote payloads), answer a bare 500."""
    frames = [
        f"{frame.filename}:{frame.lineno} in {frame.name}"
        for frame in traceback.extract_tb(exc.__traceback__)
    ]
    log.error("unhandled error", extra={"error_type": type(exc).__name__, "stack": frames})
    return problem_response(make_problem(500, ErrorCode.INTERNAL, "Unexpected error."))


def _error_names(exc: BaseException) -> list[str]:
    return [type(e).__name__ for e in _chain(exc)]


async def _service_error_handler(_request: Request, exc: Exception) -> Response:
    if not isinstance(exc, ServiceError):  # pragma: no cover - registered for ServiceError only
        raise exc
    log.warning("request failed", extra={"code": exc.code.value, "error_chain": _error_names(exc)})
    return error_response(exc)


async def _garmin_error_handler(_request: Request, exc: Exception) -> Response:
    error = from_garmin_exception(exc)
    if error is None:  # pragma: no cover - registered for Garmin exceptions only
        raise exc
    statuses = sorted({s for e in _chain(exc) if (s := _status_of(e)) is not None})
    log.warning(
        "garmin call failed",
        extra={
            "code": error.code.value,
            "garmin_status": statuses,
            "error_chain": _error_names(exc),
        },
    )
    return error_response(error)


async def _validation_handler(_request: Request, exc: Exception) -> Response:
    errors: Sequence[Any] = exc.errors() if isinstance(exc, RequestValidationError) else ()
    issues = []
    for error in errors:
        loc = [str(part) for part in error.get("loc", ())]
        if loc and loc[0] == "body":
            loc = loc[1:]
        issues.append(Issue(path=".".join(loc), message=str(error.get("msg", "Invalid value"))))
    # Never echo the input: it holds the token bundle.
    return problem_response(
        make_problem(
            400,
            ErrorCode.VALIDATION,
            "The request body does not match the contract.",
            issues=issues,
        )
    )


async def _http_error_handler(_request: Request, exc: Exception) -> Response:
    status = exc.status_code if isinstance(exc, StarletteHTTPException) else 500
    if status in (404, 405):
        code = ErrorCode.NOT_FOUND
    elif status == 401:
        code = ErrorCode.UNAUTHORIZED
    elif status == 429:
        code = ErrorCode.RATE_LIMITED
    elif 400 <= status < 500:
        code = ErrorCode.VALIDATION
    else:
        code = ErrorCode.INTERNAL
    return problem_response(make_problem(status, code))


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ServiceError, _service_error_handler)
    for exc_class in _GARMIN_EXCEPTIONS:
        app.add_exception_handler(exc_class, _garmin_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_error_handler)
