"""The one place exceptions become problem+json with the shared error codes.

garminconnect wraps errors in layers, so the class alone is misleading: login() turns a 429 or a
network failure while loading the profile into GarminConnectAuthenticationError, with the real
cause chained underneath as "API Error 429" or a requests ConnectionError. The mapping therefore
walks the whole __cause__/__context__ chain and lets an HTTP status found there win over the
outer class. The connection is reported expired only on a 401 or an auth error with no other
explanation: a false "expired" makes the runner log in again, which Garmin rate-limits hard.

A refresh inside login rotates the refresh token, and the old one stops working. When a later step
of the same request fails, the error must still hand the new bundle back, or the runner has to
reconnect with 2FA. login() therefore registers its session with the request (track_logins) before
it runs, and make_problem adds the session's rotated bundle to every error response.

A password login (/connect, /connect/mfa, the laptop CLI) has no saved token to expire, so the same
chains read differently there: from_login_exception and from_code_exception.
"""

from __future__ import annotations

import ast
import logging
import re
import traceback
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from http import HTTPStatus
from typing import Any, Protocol

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

# A failed code check's message and its outcomes per verify endpoint (Client._complete_mfa, 0.3.17).
_VERIFY_FAILED = "MFA verification failed: "
_VERIFY_RATE_LIMITED = re.compile(r"HTTP 429|429 in JSON body")
# No answer about the code: no HTTP answer at all (network error or the 30 s timeout), a page that
# is not Garmin's JSON (a Cloudflare challenge, a proxy's error page), or a 5xx named in Garmin's
# JSON. Any other JSON is Garmin's answer about the code: a refusal.
_VERIFY_NO_ANSWER = re.compile(r"connection error .*|HTTP \d{3} non-JSON|5\d\d", re.DOTALL)

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


def credentials_rejected() -> ServiceError:
    return ServiceError(
        422, ErrorCode.GARMIN_CREDENTIALS_REJECTED, "Garmin did not accept the email and password."
    )


def mfa_rejected() -> ServiceError:
    return ServiceError(
        422,
        ErrorCode.GARMIN_MFA_REJECTED,
        "Garmin did not accept the code. The same login takes another one.",
    )


def login_lost(
    detail: str = "No Garmin login is waiting for a code under this id.",
) -> ServiceError:
    return ServiceError(
        409, ErrorCode.GARMIN_LOGIN_LOST, f"{detail} Start again with the email and password."
    )


def no_reusable_login() -> ServiceError:
    # The library's web-cookie fallback, used when the DI token exchange fails, dumps null tokens.
    return ServiceError(
        502,
        ErrorCode.GARMIN_UNAVAILABLE,
        "Garmin signed in without a token the app can reuse. Wait a few minutes, then try again.",
    )


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


def _from_garmin_or_network(exc: BaseException) -> ServiceError | None:
    error = from_garmin_exception(exc)
    if error is not None:
        return error
    # requests' and curl_cffi's RequestException, socket timeouts and TLS errors are all OSError.
    if any(isinstance(e, OSError) for e in _chain(exc)):
        return unavailable()
    return None


def _verify_outcomes(exc: BaseException) -> list[str] | None:
    """Each verify endpoint's outcome when exc is the library's failed code check, else None.

    Client._complete_mfa posts the code to two endpoints, catches every failure and raises
    GarminConnectAuthenticationError(f"MFA verification failed: {failures}") with no cause: a list
    of "<verify url>: <outcome>" (0.3.17 source). The URL holds no ": ", the code is not in it.
    """
    for e in _chain(exc):
        message = str(e)
        if not (
            isinstance(e, GarminConnectAuthenticationError) and message.startswith(_VERIFY_FAILED)
        ):
            continue
        try:
            failures = ast.literal_eval(message.removeprefix(_VERIFY_FAILED))
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            return None
        if not isinstance(failures, list) or not all(isinstance(f, str) for f in failures):
            return None
        return [failure.partition(": ")[2] for failure in failures]
    return None


def _from_verify_failures(exc: BaseException) -> ServiceError | None:
    """garmin_rate_limited when an endpoint answered 429, garmin_unavailable when none answered
    about the code; None for a refusal, or a failure of another shape, left to the general mapping.

    One endpoint refusing while the other did not answer is a refusal: Garmin did check the code,
    and both endpoints share the login's session, so the same code would be refused again. Read as
    an outage, the runner would resend a wrong code believing Garmin was down; read as a refusal, a
    right code costs at most one of the MAX_CODES tries.
    """
    outcomes = _verify_outcomes(exc)
    if not outcomes:
        return None
    if any(_VERIFY_RATE_LIMITED.fullmatch(outcome) for outcome in outcomes):
        return rate_limited()
    if all(_VERIFY_NO_ANSWER.fullmatch(outcome) for outcome in outcomes):
        return unavailable()
    return None


def _from_password_login(
    exc: BaseException, rejected: Callable[[], ServiceError]
) -> ServiceError | None:
    """A password login has no token to expire: an auth error with no other explanation is Garmin
    turning down what the runner typed. Only a 429 and that refusal keep their meaning; anything
    else, a 404 or 403 in a strategy's text too, is Garmin not finishing the login.

    A failed code check is an auth error whatever happened on the wire, so its message is read
    first (_from_verify_failures): an outage there must not count as a wrong code.

    Garmin.resume_login lets a network error out with no library exception around it. During a
    login nothing else is on the wire, so that is Garmin not answering. The read routes keep
    from_garmin_exception, which leaves such an error unmapped.
    """
    verify_error = _from_verify_failures(exc)
    if verify_error is not None:
        return verify_error
    error = _from_garmin_or_network(exc)
    if error is None or error.code is ErrorCode.GARMIN_RATE_LIMITED:
        return error
    if error.code is ErrorCode.GARMIN_AUTH_EXPIRED:
        return rejected()
    return unavailable()


def from_login_exception(exc: BaseException) -> ServiceError | None:
    """Map a failed Garmin(email, password).login(); None when it is neither Garmin nor the network.

    A wrong email or password is GarminConnectAuthenticationError("401 Unauthorized (Invalid
    Username or Password)"), a locked account in the widget flow "Widget authentication failed":
    both are garmin_credentials_rejected.
    """
    return _from_password_login(exc, credentials_rejected)


def from_code_exception(exc: BaseException) -> ServiceError | None:
    """Map a failed resume_login(code); None when it is neither Garmin nor the network.

    A refused code is GarminConnectAuthenticationError("MFA verification failed: ...") or "Widget
    MFA failed: ...": garmin_mfa_rejected. The first lists each verify endpoint's outcome: a 429 on
    either is garmin_rate_limited, no answer about the code from both (network errors, non-JSON
    pages) garmin_unavailable, so an outage is not counted as a wrong code. Whether the login can
    take another code is not in the exception but in the instance (password_login.code_refused).
    """
    return _from_password_login(exc, mfa_rejected)


def from_write_exception(exc: BaseException) -> ServiceError | None:
    """Map a failed workout write; None when it is neither Garmin nor the network.

    garminconnect sends upload, schedule, unschedule and delete through client.post and
    client.delete directly, outside its API-call wrapper: no retries, a 429 or 503 arrives as a
    bare GarminConnectConnectionError("API Error 429"), and a network error or timeout as requests'
    own exception with no library exception around it, which is Garmin not answering.
    """
    return _from_garmin_or_network(exc)


class TokenSource(Protocol):
    """A Garmin session that can say whether its tokens rotated (client.GarminSession)."""

    def rotated_bundle(self) -> str | None: ...


class RequestLogins:
    """The Garmin session of the current request, once login has started."""

    def __init__(self) -> None:
        self.session: TokenSource | None = None


# Set per request by the guard middleware. It holds a mutable object, not the session itself:
# sync routes run in worker threads on a copy of the context, and the error handlers must see what
# the route thread registered.
_request_logins: ContextVar[RequestLogins | None] = ContextVar("request_logins", default=None)


@contextmanager
def track_logins() -> Iterator[RequestLogins]:
    logins = RequestLogins()
    token = _request_logins.set(logins)
    try:
        yield logins
    finally:
        _request_logins.reset(token)


def remember_login(session: TokenSource) -> None:
    """Called by login() before the library logs in: a refresh in there already rotates tokens."""
    logins = _request_logins.get()
    if logins is not None:
        logins.session = session


def rotated_bundle() -> str | None:
    """The current request's new bundle when its tokens rotated, else None."""
    logins = _request_logins.get()
    if logins is None or logins.session is None:
        return None
    return logins.session.rotated_bundle()


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
        token_bundle=rotated_bundle(),
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


def error_names(exc: BaseException) -> list[str]:
    """The classes of the cause chain, outermost first: safe to log, unlike messages."""
    return [type(e).__name__ for e in _chain(exc)]


async def _service_error_handler(_request: Request, exc: Exception) -> Response:
    if not isinstance(exc, ServiceError):  # pragma: no cover - registered for ServiceError only
        raise exc
    log.warning("request failed", extra={"code": exc.code.value, "error_chain": error_names(exc)})
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
            "error_chain": error_names(exc),
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
