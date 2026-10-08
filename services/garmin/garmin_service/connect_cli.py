"""pnpm garmin:connect <app-url>: log in to Garmin on the laptop and hand the tokens to the app.

Garmin's password login and 2FA run here, from a home network, because Garmin challenges and
rate-limits logins from cloud IPs. The app receives only the token bundle, over TLS, proves it with
one Garmin call and stores it encrypted. The bundle, both passwords and the code live in this
process's memory only: never printed, logged or written to a file.

The app sign-in comes first: a wrong app password must not spend a Garmin login, which Garmin
rate-limits for about an hour. Nothing here retries a request; only a rejected 2FA code is asked
again, on the same login. Otherwise the runner reruns the command.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import logging
import ssl
import sys
import traceback
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from email.message import Message
from getpass import getpass
from http.cookiejar import CookieJar
from typing import IO, Any
from urllib.parse import urlsplit

import certifi

from garmin_service.errors import from_login_exception
from garmin_service.models.problem import ErrorCode
from garmin_service.password_login import (
    GarminFactory,
    PasswordLogin,
    code_refused,
    has_tokens,
    real_garmin,
)

USAGE = "Usage: pnpm garmin:connect https://<name>.onrender.com"
# Render's free service sleeps when idle and holds the first request for up to a minute.
APP_TIMEOUT_S = 90.0
SIGN_OUT_TIMEOUT_S = 10.0
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1"})
# Render's proxy answers these while the service boots.
_WAKING_STATUSES = frozenset({502, 503, 504})

BAD_APP_URL = "Give the app's address, like https://<name>.onrender.com (http only for localhost)."
WAKING = "Could not reach {app}. A sleeping free server takes up to a minute to wake; try again."
TLS_UNVERIFIED = "Could not verify {app}'s TLS certificate. Check the address."
APP_REJECTED = "The app rejected that email or password."
APP_ORIGIN_REFUSED = (
    "The app refused requests from {app}. Use the exact address the app opens at in your browser."
)
APP_LIMITED = "The app is limiting sign-ins. Wait a minute, then run pnpm garmin:connect again."
GARMIN_REJECTED = "Garmin rejected the email, password or code. Run pnpm garmin:connect again."
MFA_PROMPT = "Garmin 2FA code (from the email or the Garmin app): "
MFA_ATTEMPTS = 3
CODE_REJECTED = "Garmin did not accept that code. Try again."
GARMIN_LIMITED = "Garmin is limiting logins. Wait an hour, then run pnpm garmin:connect again."
GARMIN_DOWN = "Garmin is not responding. Try again later."
NO_REUSABLE_LOGIN = (
    "Garmin signed you in without a token the server can reuse. "
    "Wait a few minutes, then run pnpm garmin:connect again."
)
UPLOAD_LOST = "Lost the connection to {app} during the upload. Run pnpm garmin:connect again."
# Keyed by the API's codes (packages/shared/src/error-codes.ts), a superset of this service's
# ErrorCode; tests check every key against the exported list.
UPLOAD_FAILURES: dict[str, str] = {
    "garmin_auth_expired": (
        "Garmin did not accept the new login from the server. Run pnpm garmin:connect again."
    ),
    "garmin_rate_limited": (
        "Garmin is limiting requests from the server. "
        "Wait an hour, then run pnpm garmin:connect again."
    ),
    "garmin_unavailable": (
        "The server could not reach Garmin. "
        "This may be Garmin blocking the server's network; try again later."
    ),
    "rate_limited": (
        "The app is limiting requests. Wait a minute, then run pnpm garmin:connect again."
    ),
    "unauthorized": "The app ended the sign-in before the upload. Run pnpm garmin:connect again.",
}
CONNECTED = "Garmin connected ({name}). Open the app and tap Sync now."


class StepError(Exception):
    """A step failed; the message is the one plain sentence the runner sees."""

    def __init__(self, message: str, *, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def app_origin(raw: str) -> str:
    """The app's origin from what the runner typed: https anywhere, http only on this machine."""
    parts = urlsplit(raw.strip())
    try:
        parts.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError:
        raise StepError(BAD_APP_URL, exit_code=2) from None
    host = parts.hostname or ""
    secure = parts.scheme == "https" or (parts.scheme == "http" and host in _LOCAL_HOSTS)
    if (
        not host
        or not secure
        or parts.username is not None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise StepError(BAD_APP_URL, exit_code=2)
    return f"{parts.scheme}://{parts.netloc.lower()}"


@dataclass(frozen=True, slots=True)
class AppAnswer:
    status: int
    body: dict[str, Any] | None

    def text(self, key: str) -> str | None:
        value = self.body.get(key) if self.body is not None else None
        return value if isinstance(value, str) and value.strip() else None


class AppUnreachableError(Exception):
    """No HTTP answer at all: refused, reset, DNS failure or timeout."""


class AppCertificateError(AppUnreachableError):
    """The TLS handshake failed: the certificate did not verify, or the address is not TLS."""


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    # Following one would replay the password to another URL; a 3xx is an answer like any other.
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: Message,
        newurl: str,
    ) -> urllib.request.Request | None:
        return None


def _json_object(raw: bytes) -> dict[str, Any] | None:
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


class AppClient:
    """The app's HTTP API over urllib, holding Better Auth's session cookie in memory only."""

    def __init__(self, origin: str, *, timeout_s: float = APP_TIMEOUT_S) -> None:
        self.origin = origin
        self._timeout_s = timeout_s
        # certifi's CA certificates, not the system's: python.org's macOS Python has an OpenSSL with
        # none until its "Install Certificates" script runs, so every https call would fail.
        tls = ssl.create_default_context(cafile=certifi.where())
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=tls),
            urllib.request.HTTPCookieProcessor(CookieJar()),
            _NoRedirects(),
        )

    def sign_in(self, email: str, password: str) -> AppAnswer:
        return self._send("POST", "/api/auth/sign-in/email", {"email": email, "password": password})

    def connect_garmin(self, token_bundle: str) -> AppAnswer:
        return self._send("PUT", "/api/garmin/connection", {"tokenBundle": token_bundle})

    def sign_out(self) -> None:
        # Best effort: the session expires on its own, and a failed sign-out must not hide the
        # outcome the runner came for.
        with contextlib.suppress(AppUnreachableError):
            self._send("POST", "/api/auth/sign-out", {}, timeout_s=SIGN_OUT_TIMEOUT_S)

    def _send(
        self, method: str, path: str, payload: dict[str, Any], *, timeout_s: float | None = None
    ) -> AppAnswer:
        # Better Auth refuses state-changing requests whose Origin is not the app's own.
        request = urllib.request.Request(  # noqa: S310 - app_origin allows https and local http only
            self.origin + path,
            data=json.dumps(payload).encode(),
            method=method,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": self.origin,
            },
        )
        try:
            with self._opener.open(request, timeout=timeout_s or self._timeout_s) as response:
                return AppAnswer(response.status, _json_object(response.read()))
        except urllib.error.HTTPError as error:
            try:
                raw = error.read()
            except (OSError, http.client.HTTPException):
                raw = b""
            finally:
                error.close()
            return AppAnswer(error.code, _json_object(raw))
        except urllib.error.URLError as error:
            # urllib wraps a failed handshake; a sleeping server is never the reason for one.
            if isinstance(error.reason, ssl.SSLError):
                raise AppCertificateError(type(error.reason).__name__) from error
            raise AppUnreachableError(type(error).__name__) from error
        except (OSError, http.client.HTTPException) as error:
            raise AppUnreachableError(type(error).__name__) from error


def _garmin_failure(exc: Exception) -> StepError | None:
    """The runner's sentence for a failed Garmin login, by errors.py's cause-chain mapping."""
    error = from_login_exception(exc)
    if error is None:
        return None
    if error.code is ErrorCode.GARMIN_RATE_LIMITED:
        return StepError(GARMIN_LIMITED)
    if error.code is ErrorCode.GARMIN_CREDENTIALS_REJECTED:
        return StepError(GARMIN_REJECTED)
    return StepError(GARMIN_DOWN)


def _verify_code(garmin: PasswordLogin, ask: Callable[[str], str]) -> None:
    """Up to MFA_ATTEMPTS codes on the one login: a typo must not cost a fresh password login.

    A 429 or an outage ends the run at once. An empty code is asked again without calling Garmin.
    """
    for attempt in range(1, MFA_ATTEMPTS + 1):
        code = ""
        while not code:
            code = ask(MFA_PROMPT).strip()
        try:
            garmin.resume_login({}, code)
        except Exception as exc:
            if attempt == MFA_ATTEMPTS or not code_refused(garmin, exc):
                raise
            print(CODE_REJECTED)
        else:
            return


def garmin_bundle(
    ask: Callable[[str], str], secret: Callable[[str], str], make_garmin: GarminFactory
) -> str:
    """One password login, with up to three 2FA codes when Garmin asks for one. Never retried."""
    email = ask("Garmin email: ").strip()
    password = secret("Garmin password: ")
    print("Logging in to Garmin...")
    try:
        garmin = make_garmin(email, password)
        status, _ = garmin.login()
        if status == "needs_mfa":
            _verify_code(garmin, ask)
        bundle = garmin.client.dumps()
    except Exception as exc:
        failure = _garmin_failure(exc)
        if failure is None:
            raise
        raise failure from exc
    # A login whose DI token exchange failed falls back to a web cookie and dumps null tokens.
    if not has_tokens(bundle):
        raise StepError(NO_REUSABLE_LOGIN)
    return bundle


def _sign_in(app: AppClient, ask: Callable[[str], str], secret: Callable[[str], str]) -> None:
    email = ask("App email: ").strip()
    password = secret("App password: ")
    print(f"Signing in to {app.origin}...")
    try:
        answer = app.sign_in(email, password)
    except AppCertificateError as exc:
        raise StepError(TLS_UNVERIFIED.format(app=app.origin)) from exc
    except AppUnreachableError as exc:
        raise StepError(WAKING.format(app=app.origin)) from exc
    if answer.status == 200:
        return
    if answer.status == 401:
        raise StepError(APP_REJECTED)
    if answer.status == 403:
        # Better Auth answers a wrong password with 401; a 403 here is INVALID_ORIGIN: the typed
        # address, sent as Origin, is not the app's APP_URL (127.0.0.1 for localhost, another port).
        raise StepError(APP_ORIGIN_REFUSED.format(app=app.origin))
    if answer.status == 429:
        raise StepError(APP_LIMITED)
    if answer.status in _WAKING_STATUSES:
        raise StepError(WAKING.format(app=app.origin))
    detail = answer.text("detail") or answer.text("message")
    raise StepError(detail or f"The app answered HTTP {answer.status}.")


def _upload(app: AppClient, bundle: str) -> str | None:
    """PUT the bundle; the app's display name for the Garmin account on success."""
    print("Handing the login to the app, which checks it with Garmin...")
    try:
        answer = app.connect_garmin(bundle)
    except AppUnreachableError as exc:
        raise StepError(UPLOAD_LOST.format(app=app.origin)) from exc
    if answer.status == 200:
        return answer.text("displayName")
    code = answer.text("code")
    if code in UPLOAD_FAILURES:
        raise StepError(UPLOAD_FAILURES[code])
    if answer.status == 409:
        raise StepError(UPLOAD_FAILURES["garmin_auth_expired"])
    raise StepError(answer.text("detail") or f"The app answered HTTP {answer.status}.")


def run(
    argv: Sequence[str],
    *,
    ask: Callable[[str], str] = input,
    secret: Callable[[str], str] = getpass,
    make_garmin: GarminFactory = real_garmin,
    make_app: Callable[[str], AppClient] = AppClient,
) -> int:
    """The whole command; returns the exit code. A failure is one plain sentence on stderr."""
    try:
        if len(argv) != 1:
            raise StepError(USAGE, exit_code=2)
        app = make_app(app_origin(argv[0]))
        _sign_in(app, ask, secret)
        try:
            display_name = _upload(app, garmin_bundle(ask, secret, make_garmin))
        finally:
            app.sign_out()
    except StepError as failure:
        print(failure, file=sys.stderr)
        return failure.exit_code
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130
    except Exception as exc:
        # Messages can quote request data; the class and where it happened are enough to debug.
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        where = f"{frame.filename}:{frame.lineno}"
        print(f"Unexpected error: {type(exc).__name__} at {where}.", file=sys.stderr)
        return 1
    print(CONNECTED.format(name=display_name or "no display name"))
    return 0


def main() -> None:
    # The library logs every login strategy that falls through (often a 429 before the one that
    # works); the runner gets one sentence about the outcome instead.
    logging.getLogger("garminconnect").setLevel(logging.CRITICAL)
    sys.exit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
