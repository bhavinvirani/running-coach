"""Garmin's password login with 2FA, shared by the laptop CLI (connect_cli) and /connect.

Garmin(email, password, return_on_mfa=True).login() answers ("needs_mfa", None) when Garmin asks for
a code, and resume_login({}, code) finishes the login on that same instance: its MFA state is a live
HTTP session, which cannot be serialized. Neither call goes through GarminSession.call's pacing (a
person types between them) and neither is retried: each try is another login, which Garmin
rate-limits for about an hour.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Annotated, Any, Protocol

from fastapi import Depends, Request
from garminconnect import Garmin

from garmin_service.errors import from_code_exception
from garmin_service.fake_client import FakePasswordLogin
from garmin_service.models.problem import ErrorCode


class TokenDump(Protocol):
    def dumps(self) -> str: ...


class PasswordLogin(Protocol):
    """The part of garminconnect.Garmin a password login uses. Tests pass a fake."""

    # Garmin keeps it on the instance until a full login clears it; a login waiting for its code
    # has no use for it (resume_login never reads it), so /connect clears it at once.
    password: str | None

    @property
    def client(self) -> TokenDump: ...

    def login(self) -> tuple[str | None, Any]: ...

    def resume_login(self, client_state: dict[str, Any], mfa_code: str) -> tuple[Any, Any]: ...


GarminFactory = Callable[[str, str], PasswordLogin]


def real_garmin(email: str, password: str) -> PasswordLogin:
    # login() without a tokenstore reads GARMINTOKENS and would reuse that file instead of logging
    # in; a password login is always a fresh one and never touches a token file.
    os.environ.pop("GARMINTOKENS", None)
    return Garmin(email, password, return_on_mfa=True)


def factory_for(*, fixtures: bool) -> GarminFactory:
    return FakePasswordLogin if fixtures else real_garmin


def has_tokens(bundle: str) -> bool:
    """Both DI tokens are set: a login whose DI token exchange failed falls back to a web cookie
    and dumps null tokens, a bundle no other process can use."""
    try:
        tokens = json.loads(bundle)
    except ValueError:
        return False
    return isinstance(tokens, dict) and all(
        isinstance(tokens.get(key), str) and tokens[key] for key in ("di_token", "di_refresh_token")
    )


def mfa_pending(garmin: PasswordLogin) -> bool:
    """The login still waits for a code, so resume_login on this instance can take another one.

    garminconnect's Client sets _mfa_pending when login() returns needs_mfa and clears it when
    resume_login succeeds or the token it got is rejected (0.3.17 source; a test pins the
    attribute). A refused or rate-limited code leaves it set. Garmin.resume_login then loads the
    profile with the tokens in place, so tokens in dumps() mean the code was accepted and another
    one cannot work. Fakes without the attribute are judged by the tokens alone.
    """
    if has_tokens(garmin.client.dumps()):
        return False
    pending = getattr(garmin.client, "_mfa_pending", None)
    return pending if isinstance(pending, bool) else True


def code_refused(garmin: PasswordLogin, exc: BaseException) -> bool:
    """Garmin refused the code itself, and the same login can take another one."""
    error = from_code_exception(exc)
    return error is not None and error.code is ErrorCode.GARMIN_MFA_REJECTED and mfa_pending(garmin)


def get_password_login(request: Request) -> GarminFactory:
    make_garmin: GarminFactory = request.app.state.password_login
    return make_garmin


PasswordLoginDep = Annotated[GarminFactory, Depends(get_password_login)]
