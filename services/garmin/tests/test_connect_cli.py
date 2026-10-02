"""pnpm garmin:connect: the laptop CLI against a fake app on 127.0.0.1 and a scripted Garmin login.

The fake app is a real HTTP server, so urllib, the cookie jar and the headers run as they do against
Render. Garmin failures are raised the way garminconnect raises them from a password login.
"""

from __future__ import annotations

import json
import os
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

from garmin_service.connect_cli import (
    APP_LIMITED,
    APP_ORIGIN_REFUSED,
    APP_REJECTED,
    BAD_APP_URL,
    CODE_REJECTED,
    GARMIN_DOWN,
    GARMIN_LIMITED,
    GARMIN_REJECTED,
    MFA_PROMPT,
    NO_REUSABLE_LOGIN,
    TLS_UNVERIFIED,
    UPLOAD_FAILURES,
    UPLOAD_LOST,
    USAGE,
    WAKING,
    AppAnswer,
    AppClient,
    GarminFactory,
    app_origin,
    real_garmin,
    run,
)
from garmin_service.fake_client import FakeTokenStore
from tests.helpers import JSON_SCHEMA_DIR, assert_valid

APP_EMAIL = "runner@example.com"
APP_PASSWORD = "app-password-not-real"
GARMIN_EMAIL = "garmin-runner@example.com"
GARMIN_PASSWORD = "garmin-password-not-real"
MFA_CODE = "418093"
WRONG_CODE = "418039"
BUNDLE = json.dumps(
    {
        "di_token": "laptop-di-token-not-real",
        "di_refresh_token": "laptop-refresh-token-not-real",
        "di_client_id": "laptop-client-not-real",
    }
)
SECRETS = (
    APP_PASSWORD,
    GARMIN_PASSWORD,
    MFA_CODE,
    WRONG_CODE,
    "laptop-di-token",
    "laptop-refresh-token",
)
SESSION_COOKIE = "better-auth.session_token=fake-session"

SIGN_IN = "/api/auth/sign-in/email"
CONNECTION = "/api/garmin/connection"
SIGN_OUT = "/api/auth/sign-out"
SERVICE_DIR = Path(__file__).resolve().parents[1]


def problem(status: int, code: str, detail: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"type": "about:blank", "title": "Error", "status": status, "code": code}
    if detail is not None:
        body["detail"] = detail
    return body


@dataclass
class Received:
    method: str
    path: str
    headers: dict[str, str]
    body: Any


@dataclass
class FakeApp:
    """The app's HTTP surface the CLI uses: Better Auth sign-in and sign-out, the bundle upload."""

    answers: dict[str, tuple[int, dict[str, Any]]] = field(
        default_factory=lambda: {
            SIGN_IN: (200, {"user": {"id": "00000000-0000-4000-8000-000000000001"}}),
            CONNECTION: (200, {"displayName": "Alex Fixture"}),
            SIGN_OUT: (200, {"success": True}),
        }
    )
    received: list[Received] = field(default_factory=list)
    delay_s: float = 0.0
    redirect_sign_in: bool = False

    def __post_init__(self) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._server.daemon_threads = True
        # The default 0.5 s poll makes every shutdown wait half a second.
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def paths(self) -> list[str]:
        return [r.path for r in self.received]

    def request_to(self, path: str) -> Received:
        return next(r for r in self.received if r.path == path)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        app = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self._answer()

            def do_PUT(self) -> None:
                self._answer()

            def log_message(self, format: str, *args: Any) -> None:
                pass

            def _answer(self) -> None:
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                app.received.append(
                    Received(
                        self.command,
                        self.path,
                        {k.lower(): v for k, v in self.headers.items()},
                        json.loads(raw) if raw else None,
                    )
                )
                if app.delay_s:
                    time.sleep(app.delay_s)
                if app.redirect_sign_in and self.path == SIGN_IN:
                    self.send_response(307)
                    self.send_header("Location", "/elsewhere")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status, body = app.answers.get(self.path, (404, problem(404, "not_found")))
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header(
                    "Content-Type",
                    "application/json" if status == 200 else "application/problem+json",
                )
                self.send_header("Content-Length", str(len(payload)))
                if self.path == SIGN_IN and status == 200:
                    self.send_header("Set-Cookie", f"{SESSION_COOKIE}; Path=/; HttpOnly")
                self.end_headers()
                self.wfile.write(payload)

        return Handler


@pytest.fixture
def fake_app() -> Iterator[FakeApp]:
    app = FakeApp()
    app.start()
    yield app
    app.stop()


class FakeLogin:
    """Implements PasswordLogin with scripted outcomes and records every call."""

    def __init__(
        self,
        *,
        needs_mfa: bool = False,
        login_error: BaseException | None = None,
        resume_errors: Sequence[BaseException] = (),
        accepts_code_before_error: bool = False,
        bundle: str = BUNDLE,
    ) -> None:
        self._tokens = FakeTokenStore()
        self._needs_mfa = needs_mfa
        self._login_error = login_error
        # The n-th resume_login raises the n-th error; calls past the list accept the code.
        self._resume_errors = list(resume_errors)
        # Garmin.resume_login loads the profile after the code is accepted, so it can fail after
        # the tokens are in place.
        self._accepts_code_before_error = accepts_code_before_error
        self._bundle = bundle
        self.calls: list[str] = []
        self.credentials: list[tuple[str, str]] = []
        self.codes: list[str] = []

    @property
    def client(self) -> FakeTokenStore:
        return self._tokens

    def login(self) -> tuple[str | None, Any]:
        self.calls.append("login")
        if self._login_error is not None:
            raise self._login_error
        if self._needs_mfa:
            return "needs_mfa", None
        self._tokens.bundle = self._bundle
        return None, None

    def resume_login(self, client_state: dict[str, Any], mfa_code: str) -> tuple[Any, Any]:
        self.calls.append("resume_login")
        self.codes.append(mfa_code)
        if self._accepts_code_before_error:
            self._tokens.bundle = self._bundle
        if self._resume_errors:
            raise self._resume_errors.pop(0)
        self._tokens.bundle = self._bundle
        return None, None

    def factory(self) -> GarminFactory:
        def make(email: str, password: str) -> FakeLogin:
            self.credentials.append((email, password))
            return self

        return make


class Console:
    """Scripted answers for input() and getpass(), recording which prompts read without echo."""

    def __init__(self, typed: list[str], hidden: list[str]) -> None:
        self._typed = list(typed)
        self._hidden = list(hidden)
        self.typed_prompts: list[str] = []
        self.hidden_prompts: list[str] = []

    def ask(self, prompt: str) -> str:
        self.typed_prompts.append(prompt)
        return self._typed.pop(0)

    def secret(self, prompt: str) -> str:
        self.hidden_prompts.append(prompt)
        return self._hidden.pop(0)


def connect(
    app_url: str,
    garmin: FakeLogin,
    *,
    console: Console | None = None,
    make_app: Callable[[str], AppClient] = AppClient,
) -> int:
    console = console or Console(
        [APP_EMAIL, GARMIN_EMAIL, MFA_CODE], [APP_PASSWORD, GARMIN_PASSWORD]
    )
    return run(
        [app_url],
        ask=console.ask,
        secret=console.secret,
        make_garmin=garmin.factory(),
        make_app=make_app,
    )


def auth_failure(message: str) -> GarminConnectAuthenticationError:
    return GarminConnectAuthenticationError(message)


def closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
    return port


def test_connects_without_2fa_and_uploads_the_bundle(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = FakeLogin()

    assert connect(fake_app.origin, garmin) == 0

    assert garmin.credentials == [(GARMIN_EMAIL, GARMIN_PASSWORD)]
    assert garmin.calls == ["login"]
    assert fake_app.paths() == [SIGN_IN, CONNECTION, SIGN_OUT]
    assert fake_app.request_to(SIGN_IN).body == {"email": APP_EMAIL, "password": APP_PASSWORD}
    assert fake_app.request_to(CONNECTION).method == "PUT"
    assert fake_app.request_to(CONNECTION).body == {"tokenBundle": BUNDLE}
    out = capsys.readouterr().out
    assert "Garmin connected (Alex Fixture). Open the app and tap Sync now." in out


def test_says_no_display_name_when_the_app_returns_null(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    fake_app.answers[CONNECTION] = (200, {"displayName": None})

    assert connect(fake_app.origin, FakeLogin()) == 0

    assert "Garmin connected (no display name)." in capsys.readouterr().out


def test_asks_for_the_2fa_code_and_resumes_when_garmin_needs_mfa(fake_app: FakeApp) -> None:
    garmin = FakeLogin(needs_mfa=True)

    assert connect(fake_app.origin, garmin) == 0

    assert garmin.calls == ["login", "resume_login"]
    assert garmin.codes == [MFA_CODE]
    assert fake_app.request_to(CONNECTION).body == {"tokenBundle": BUNDLE}


def code_refused() -> GarminConnectAuthenticationError:
    # What the library raises when every MFA verify endpoint refuses the code.
    return auth_failure("MFA verification failed: ['verifyCode: INVALID_MFA_CODE']")


def test_a_rejected_2fa_code_asks_again_and_the_next_code_uploads_with_one_garmin_login(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = FakeLogin(needs_mfa=True, resume_errors=[code_refused()])
    console = Console(
        [APP_EMAIL, GARMIN_EMAIL, WRONG_CODE, MFA_CODE], [APP_PASSWORD, GARMIN_PASSWORD]
    )

    assert connect(fake_app.origin, garmin, console=console) == 0

    assert garmin.calls == ["login", "resume_login", "resume_login"]
    assert garmin.codes == [WRONG_CODE, MFA_CODE]
    assert console.typed_prompts.count(MFA_PROMPT) == 2
    assert fake_app.request_to(CONNECTION).body == {"tokenBundle": BUNDLE}
    captured = capsys.readouterr()
    assert CODE_REJECTED in captured.out
    assert captured.err == ""
    for secret in SECRETS:
        assert secret not in captured.out


def test_three_rejected_2fa_codes_exit_1_and_upload_nothing(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = FakeLogin(
        needs_mfa=True, resume_errors=[code_refused(), code_refused(), code_refused()]
    )
    console = Console(
        [APP_EMAIL, GARMIN_EMAIL, WRONG_CODE, WRONG_CODE, WRONG_CODE, MFA_CODE],
        [APP_PASSWORD, GARMIN_PASSWORD],
    )

    assert connect(fake_app.origin, garmin, console=console) == 1

    assert garmin.calls == ["login", "resume_login", "resume_login", "resume_login"]
    assert console.typed_prompts.count(MFA_PROMPT) == 3
    assert fake_app.paths() == [SIGN_IN, SIGN_OUT]
    captured = capsys.readouterr()
    assert captured.out.count(CODE_REJECTED) == 2
    assert captured.err.strip() == GARMIN_REJECTED


def test_an_empty_2fa_code_asks_again_without_calling_garmin(fake_app: FakeApp) -> None:
    garmin = FakeLogin(needs_mfa=True)
    console = Console(
        [APP_EMAIL, GARMIN_EMAIL, "", "   ", MFA_CODE], [APP_PASSWORD, GARMIN_PASSWORD]
    )

    assert connect(fake_app.origin, garmin, console=console) == 0

    assert garmin.calls == ["login", "resume_login"]
    assert garmin.codes == [MFA_CODE]
    assert console.typed_prompts.count(MFA_PROMPT) == 3


@pytest.mark.parametrize(
    ("error", "message"),
    [
        pytest.param(
            GarminConnectTooManyRequestsError("MFA verification rate limited on all endpoints"),
            GARMIN_LIMITED,
            id="garmin 429 on the code",
        ),
        pytest.param(
            # resume_login lets requests' errors through unwrapped; they derive from OSError.
            ConnectionError("connection reset by peer"),
            GARMIN_DOWN,
            id="network error while verifying the code",
        ),
        pytest.param(TimeoutError("timed out"), GARMIN_DOWN, id="timeout while verifying the code"),
    ],
)
def test_a_429_or_network_error_on_the_2fa_code_exits_1_without_asking_again(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str], error: BaseException, message: str
) -> None:
    garmin = FakeLogin(needs_mfa=True, resume_errors=[error])
    console = Console(
        [APP_EMAIL, GARMIN_EMAIL, MFA_CODE, MFA_CODE], [APP_PASSWORD, GARMIN_PASSWORD]
    )

    assert connect(fake_app.origin, garmin, console=console) == 1

    assert garmin.calls == ["login", "resume_login"]
    assert console.typed_prompts.count(MFA_PROMPT) == 1
    assert CONNECTION not in fake_app.paths()
    captured = capsys.readouterr()
    assert CODE_REJECTED not in captured.out
    assert captured.err.strip() == message


def test_a_failure_after_garmin_accepted_the_code_does_not_ask_for_another(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    # The profile load after a good code clears the MFA session, so another code cannot work.
    garmin = FakeLogin(
        needs_mfa=True,
        resume_errors=[auth_failure("Invalid user settings found")],
        accepts_code_before_error=True,
    )
    console = Console(
        [APP_EMAIL, GARMIN_EMAIL, MFA_CODE, MFA_CODE], [APP_PASSWORD, GARMIN_PASSWORD]
    )

    assert connect(fake_app.origin, garmin, console=console) == 1

    assert garmin.calls == ["login", "resume_login"]
    assert CONNECTION not in fake_app.paths()
    assert CODE_REJECTED not in capsys.readouterr().out


def test_garmin_429_at_login_exits_1_without_retrying_and_uploads_nothing(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = FakeLogin(
        login_error=GarminConnectTooManyRequestsError("All login strategies rate limited (429).")
    )

    assert connect(fake_app.origin, garmin) == 1

    assert garmin.calls == ["login"]
    assert CONNECTION not in fake_app.paths()
    assert GARMIN_LIMITED in capsys.readouterr().err


def login_failed(message: str, cause: BaseException) -> BaseException:
    error = GarminConnectConnectionError(f"Login failed: {message}")
    error.__cause__ = cause
    return error


@pytest.mark.parametrize(
    ("garmin", "message"),
    [
        pytest.param(
            FakeLogin(login_error=auth_failure("401 Unauthorized (Invalid Username or Password)")),
            GARMIN_REJECTED,
            id="wrong garmin password",
        ),
        pytest.param(
            FakeLogin(
                login_error=login_failed(
                    "All login strategies exhausted: CAPTCHA required",
                    GarminConnectConnectionError("All login strategies exhausted"),
                )
            ),
            GARMIN_DOWN,
            id="garmin outage or bot challenge",
        ),
        pytest.param(
            FakeLogin(login_error=login_failed("API Error 503", ConnectionError("reset"))),
            GARMIN_DOWN,
            id="garmin 503",
        ),
    ],
)
def test_a_failed_garmin_login_exits_1_with_one_sentence_and_uploads_nothing(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str], garmin: FakeLogin, message: str
) -> None:
    assert connect(fake_app.origin, garmin) == 1

    assert garmin.calls.count("login") == 1
    assert CONNECTION not in fake_app.paths()
    assert capsys.readouterr().err.strip() == message


def test_a_login_without_reusable_di_tokens_uploads_nothing(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    # The library's web-cookie fallback, when the DI token exchange fails, dumps null tokens.
    empty = json.dumps({"di_token": None, "di_refresh_token": None, "di_client_id": None})

    assert connect(fake_app.origin, FakeLogin(bundle=empty)) == 1

    assert CONNECTION not in fake_app.paths()
    assert NO_REUSABLE_LOGIN in capsys.readouterr().err


def test_a_wrong_app_password_exits_1_before_any_garmin_login(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    fake_app.answers[SIGN_IN] = (
        401,
        {"code": "INVALID_EMAIL_OR_PASSWORD", "message": "Invalid email or password"},
    )
    garmin = FakeLogin()
    console = Console([APP_EMAIL, GARMIN_EMAIL], [APP_PASSWORD, GARMIN_PASSWORD])

    assert connect(fake_app.origin, garmin, console=console) == 1

    assert garmin.credentials == []
    assert console.typed_prompts == ["App email: "]
    assert fake_app.paths() == [SIGN_IN]
    assert capsys.readouterr().err.strip() == APP_REJECTED


def test_a_sign_in_refused_for_invalid_origin_names_the_address_not_the_password(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    # Better Auth's answer when the Origin (from the typed address) is not the app's APP_URL.
    fake_app.answers[SIGN_IN] = (403, {"message": "Invalid origin"})
    garmin = FakeLogin()

    assert connect(fake_app.origin, garmin) == 1

    assert garmin.credentials == []
    assert fake_app.paths() == [SIGN_IN]
    err = capsys.readouterr().err.strip()
    assert err == APP_ORIGIN_REFUSED.format(app=fake_app.origin)
    assert err != APP_REJECTED


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        pytest.param((429, problem(429, "rate_limited")), APP_LIMITED, id="app rate limit"),
        pytest.param((503, {}), WAKING, id="render still waking"),
        pytest.param(
            (400, problem(400, "validation", "The email is not valid.")),
            "The email is not valid.",
            id="problem detail",
        ),
        pytest.param((500, {}), "The app answered HTTP 500.", id="no detail"),
    ],
)
def test_other_sign_in_answers_exit_1_before_any_garmin_login(
    fake_app: FakeApp,
    capsys: pytest.CaptureFixture[str],
    answer: tuple[int, dict[str, Any]],
    message: str,
) -> None:
    fake_app.answers[SIGN_IN] = answer
    garmin = FakeLogin()

    assert connect(fake_app.origin, garmin) == 1

    assert garmin.credentials == []
    assert capsys.readouterr().err.strip() == message.format(app=fake_app.origin)


def test_an_upload_answered_409_prints_the_reconnect_message_and_exits_1(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    fake_app.answers[CONNECTION] = (409, problem(409, "garmin_auth_expired"))

    assert connect(fake_app.origin, FakeLogin()) == 1

    err = capsys.readouterr().err.strip()
    assert err == UPLOAD_FAILURES["garmin_auth_expired"]
    assert "Run pnpm garmin:connect again." in err
    assert fake_app.paths() == [SIGN_IN, CONNECTION, SIGN_OUT]


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        pytest.param(
            (429, problem(429, "garmin_rate_limited")),
            UPLOAD_FAILURES["garmin_rate_limited"],
            id="garmin 429 from the server",
        ),
        pytest.param(
            (502, problem(502, "garmin_unavailable")),
            UPLOAD_FAILURES["garmin_unavailable"],
            id="garmin outage or blocked server network",
        ),
        pytest.param(
            (429, problem(429, "rate_limited")),
            UPLOAD_FAILURES["rate_limited"],
            id="app rate limit",
        ),
        pytest.param(
            (401, problem(401, "unauthorized")),
            UPLOAD_FAILURES["unauthorized"],
            id="session gone",
        ),
        pytest.param((409, {}), UPLOAD_FAILURES["garmin_auth_expired"], id="409 without a body"),
        pytest.param(
            (400, problem(400, "validation", "The token bundle is not valid.")),
            "The token bundle is not valid.",
            id="problem detail",
        ),
    ],
)
def test_a_failed_upload_exits_1_with_one_sentence_per_code_and_signs_out(
    fake_app: FakeApp,
    capsys: pytest.CaptureFixture[str],
    answer: tuple[int, dict[str, Any]],
    message: str,
) -> None:
    fake_app.answers[CONNECTION] = answer

    assert connect(fake_app.origin, FakeLogin()) == 1

    assert capsys.readouterr().err.strip() == message
    assert fake_app.paths()[-1] == SIGN_OUT


def test_every_upload_failure_is_keyed_by_a_shared_error_code() -> None:
    schema = json.loads((JSON_SCHEMA_DIR / "error-code.json").read_text(encoding="utf-8"))

    assert set(UPLOAD_FAILURES) <= set(schema["enum"])


def test_sends_the_origin_header_and_session_cookie_on_the_upload(fake_app: FakeApp) -> None:
    assert connect(fake_app.origin, FakeLogin()) == 0

    sign_in = fake_app.request_to(SIGN_IN)
    upload = fake_app.request_to(CONNECTION)
    sign_out = fake_app.request_to(SIGN_OUT)
    assert sign_in.headers["origin"] == fake_app.origin
    assert "cookie" not in sign_in.headers
    for request in (upload, sign_out):
        assert request.headers["origin"] == fake_app.origin
        assert request.headers["cookie"] == SESSION_COOKIE
        assert request.headers["content-type"] == "application/json"


def test_never_prints_the_bundle_passwords_or_code_and_reads_passwords_without_echo(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    console = Console([APP_EMAIL, GARMIN_EMAIL, MFA_CODE], [APP_PASSWORD, GARMIN_PASSWORD])
    assert connect(fake_app.origin, FakeLogin(needs_mfa=True), console=console) == 0
    fake_app.answers[CONNECTION] = (409, problem(409, "garmin_auth_expired"))
    assert connect(fake_app.origin, FakeLogin(needs_mfa=True)) == 1

    captured = capsys.readouterr()
    for secret in SECRETS:
        assert secret not in captured.out
        assert secret not in captured.err
    assert console.hidden_prompts == ["App password: ", "Garmin password: "]
    # The Garmin password and code never leave the laptop; only the bundle does.
    sent = json.dumps([r.body for r in fake_app.received])
    assert GARMIN_PASSWORD not in sent
    assert MFA_CODE not in sent


def test_the_upload_body_validates_against_connect_garmin_request(fake_app: FakeApp) -> None:
    assert connect(fake_app.origin, FakeLogin()) == 0

    assert_valid("connect-garmin-request", fake_app.request_to(CONNECTION).body)
    # The fake app's answer is the contract the API implements.
    assert_valid("connect-garmin-response", fake_app.answers[CONNECTION][1])


def test_an_unreachable_app_gives_the_waking_hint_and_never_logs_in_to_garmin(
    capsys: pytest.CaptureFixture[str],
) -> None:
    origin = f"http://127.0.0.1:{closed_port()}"
    garmin = FakeLogin()

    assert connect(origin, garmin) == 1

    assert garmin.credentials == []
    assert capsys.readouterr().err.strip() == WAKING.format(app=origin)


def test_the_app_client_verifies_tls_against_loaded_ca_certificates() -> None:
    client = AppClient("https://coach.onrender.com")

    # typeshed declares neither attribute; both are plain instance attributes in CPython.
    handlers = vars(client._opener)["handlers"]
    https = [h for h in handlers if isinstance(h, urllib.request.HTTPSHandler)]

    assert len(https) == 1
    context = vars(https[0])["_context"]
    assert isinstance(context, ssl.SSLContext)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    # python.org's macOS Python has none in its default context, so every https call failed.
    assert context.cert_store_stats()["x509_ca"] > 0


def test_an_unverified_tls_certificate_says_so_without_the_waking_hint_or_a_garmin_login(
    fake_app: FakeApp, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def unverified(*args: Any, **kwargs: Any) -> ssl.SSLSocket:
        raise ssl.SSLCertVerificationError(
            1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"
        )

    # The TCP connection reaches the fake app; the handshake fails the way a missing CA store does.
    monkeypatch.setattr(ssl.SSLContext, "wrap_socket", unverified)
    origin = fake_app.origin.replace("http://", "https://")
    garmin = FakeLogin()

    assert connect(origin, garmin) == 1

    assert garmin.credentials == []
    assert fake_app.paths() == []
    err = capsys.readouterr().err.strip()
    assert err == TLS_UNVERIFIED.format(app=origin)
    assert err != WAKING.format(app=origin)


def test_an_app_that_does_not_answer_in_time_gives_the_waking_hint(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    fake_app.delay_s = 0.5
    garmin = FakeLogin()

    def impatient(origin: str) -> AppClient:
        return AppClient(origin, timeout_s=0.1)

    assert connect(fake_app.origin, garmin, make_app=impatient) == 1

    assert garmin.credentials == []
    assert capsys.readouterr().err.strip() == WAKING.format(app=fake_app.origin)


def test_a_connection_lost_during_the_upload_says_to_run_again(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    class DropsUpload(AppClient):
        def connect_garmin(self, token_bundle: str) -> AppAnswer:
            fake_app.stop()
            return super().connect_garmin(token_bundle)

    assert connect(fake_app.origin, FakeLogin(), make_app=DropsUpload) == 1

    assert capsys.readouterr().err.strip() == UPLOAD_LOST.format(app=fake_app.origin)


def test_does_not_follow_a_redirect_with_the_password(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    fake_app.redirect_sign_in = True
    garmin = FakeLogin()

    assert connect(fake_app.origin, garmin) == 1

    assert fake_app.paths() == [SIGN_IN]
    assert garmin.credentials == []
    assert capsys.readouterr().err.strip() == "The app answered HTTP 307."


def test_an_unexpected_error_prints_its_class_but_not_its_message(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = FakeLogin(login_error=RuntimeError(f"boom {GARMIN_PASSWORD}"))

    assert connect(fake_app.origin, garmin) == 1

    err = capsys.readouterr().err
    assert "Unexpected error: RuntimeError at " in err
    assert GARMIN_PASSWORD not in err
    assert fake_app.paths() == [SIGN_IN, SIGN_OUT]


def test_ctrl_c_at_a_prompt_cancels_with_exit_130(
    fake_app: FakeApp, capsys: pytest.CaptureFixture[str]
) -> None:
    def interrupted(prompt: str) -> str:
        raise KeyboardInterrupt

    code = run([fake_app.origin], ask=interrupted, secret=interrupted)

    assert code == 130
    assert "Cancelled." in capsys.readouterr().err
    assert fake_app.paths() == []


@pytest.mark.parametrize(
    ("raw", "origin"),
    [
        ("https://coach.onrender.com", "https://coach.onrender.com"),
        ("https://coach.onrender.com/", "https://coach.onrender.com"),
        ("  https://Coach.onrender.com/  ", "https://coach.onrender.com"),
        ("http://localhost:3000", "http://localhost:3000"),
        ("http://127.0.0.1:3000/", "http://127.0.0.1:3000"),
    ],
)
def test_accepts_https_and_local_http_app_urls_and_strips_the_trailing_slash(
    raw: str, origin: str
) -> None:
    assert app_origin(raw) == origin


@pytest.mark.parametrize(
    "raw",
    [
        "http://coach.onrender.com",
        "coach.onrender.com",
        "ftp://coach.onrender.com",
        "https://coach.onrender.com/today",
        "https://coach.onrender.com/?next=1",
        "https://owner:secret@coach.onrender.com",
        "https://coach.onrender.com:notaport",
        "https://",
    ],
)
def test_rejects_other_app_urls_with_exit_2_before_any_prompt(
    raw: str, capsys: pytest.CaptureFixture[str]
) -> None:
    console = Console([], [])

    assert (
        run([raw], ask=console.ask, secret=console.secret, make_garmin=FakeLogin().factory()) == 2
    )

    assert console.typed_prompts == console.hidden_prompts == []
    err = capsys.readouterr().err
    assert err.strip() == BAD_APP_URL
    assert "secret" not in err


def test_real_garmin_ignores_garmintokens_and_returns_on_mfa(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GARMINTOKENS", str(SERVICE_DIR / "not-a-token-file"))

    garmin = real_garmin(GARMIN_EMAIL, GARMIN_PASSWORD)

    assert "GARMINTOKENS" not in os.environ
    assert isinstance(garmin, Garmin)
    assert garmin.return_on_mfa is True


def test_running_the_module_without_an_app_url_prints_the_usage_and_exits_2() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "garmin_service.connect_cli"],
        cwd=SERVICE_DIR,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 2
    assert result.stderr.strip() == USAGE
