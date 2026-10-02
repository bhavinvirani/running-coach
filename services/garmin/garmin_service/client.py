"""Builds the per-request Garmin client: the real garminconnect.Garmin, or the fixture fake.

Stateless by design: a client lives for one request and nothing is cached across requests.
Garmin().login(tokenstore=<bundle JSON>) loads the tokens, refreshes them when the access token is
within 15 minutes of expiry (the refresh token then rotates) and loads the social profile, so login
alone proves the bundle works. Routes return client.dumps() as the new bundle; error responses carry
it too when it rotated (errors.py).
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from typing import Annotated, Any, Protocol

from fastapi import Depends, Request
from garminconnect import Garmin

from garmin_service.errors import auth_expired, remember_login
from garmin_service.fake_client import FakeGarmin

log = logging.getLogger(__name__)

# At least this long between the end of one library call and the start of the next.
GARMIN_CALL_GAP_S = 1.0
# The library retries 5xx and network errors itself, with backoff and jitter, never 401 or 429.
# Quick retries belong here: they reuse the session login() opened, while every request from the
# API is a new Garmin login. The API retries only when this service gave no answer at all, never
# an error answer; the sync job retries the whole sync minutes later.
GARMIN_RETRY_ATTEMPTS = 2


class TokenStore(Protocol):
    def dumps(self) -> str: ...


class GarminApi(Protocol):
    """The part of garminconnect.Garmin the routes use. FakeGarmin implements the same."""

    @property
    def client(self) -> TokenStore: ...

    @property
    def display_name(self) -> str | None: ...

    @property
    def full_name(self) -> str | None: ...

    def login(self, /, tokenstore: str | None = None) -> tuple[str | None, str | None]: ...

    def get_activities_by_date(
        self,
        startdate: str,
        enddate: str | None = None,
        activitytype: str | None = None,
        sortorder: str | None = None,
    ) -> list[dict[str, Any]]: ...

    def get_activities(
        self,
        start: int = 0,
        limit: int = 20,
        activitytype: str | None = None,
        activitysubtype: str | None = None,
    ) -> dict[str, Any] | list[Any]: ...

    def get_activity_splits(self, activity_id: str) -> dict[str, Any]: ...

    def get_activity_details(
        self, activity_id: str, maxchart: int = 2000, maxpoly: int = 4000
    ) -> dict[str, Any]: ...

    # Typed dict by the library; Garmin answers a list of zones ({} on 204 No Content).
    def get_activity_hr_in_timezones(self, activity_id: str) -> dict[str, Any] | list[Any]: ...

    # Typed dict by the library; Garmin answers a list of records ({} on 204 No Content).
    def get_personal_record(self) -> dict[str, Any] | list[Any]: ...


class GarminSession:
    """One logged-in client for one request.

    Every library call goes through call(), which keeps GARMIN_CALL_GAP_S between calls.
    """

    def __init__(
        self,
        api: GarminApi,
        *,
        gap_s: float,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        sent_bundle: str | None = None,
    ) -> None:
        self.api = api
        self.sent_bundle = sent_bundle
        self._gap_s = gap_s
        self._sleep = sleep
        self._clock = clock
        self._last_call_end: float | None = None

    def call[**P, R](self, fn: Callable[P, R], /, *args: P.args, **kwargs: P.kwargs) -> R:
        if self._last_call_end is not None:
            wait = self._last_call_end + self._gap_s - self._clock()
            if wait > 0:
                self._sleep(wait)
        try:
            return fn(*args, **kwargs)
        finally:
            self._last_call_end = self._clock()

    def token_bundle(self) -> str:
        """The bundle to hand back: refreshed when login rotated the tokens, else unchanged."""
        return self.api.client.dumps()

    def rotated_bundle(self) -> str | None:
        """dumps() when it holds other tokens than the bundle sent, else None.

        It runs while an error response is built, so it never raises, and it never returns a bundle
        without tokens: a login that failed half-way must not overwrite the stored one.
        """
        if self.sent_bundle is None:
            return None
        try:
            current = self.api.client.dumps()
            if current == self.sent_bundle:
                return None
            tokens = json.loads(current)
            if not isinstance(tokens, dict) or not all(
                isinstance(tokens.get(key), str) and tokens[key]
                for key in ("di_token", "di_refresh_token")
            ):
                return None
            # Same tokens, other formatting: nothing to write back.
            return None if tokens == json.loads(self.sent_bundle) else current
        except Exception as exc:
            log.warning(
                "could not read the token bundle after a failure",
                extra={"error_type": type(exc).__name__},
            )
            return None

    def display_name(self) -> str | None:
        """A name for the UI: Garmin's full name, else its display name (often an opaque handle)."""
        for name in (self.api.full_name, self.api.display_name):
            if name and name.strip():
                return name.strip()
        return None


Connect = Callable[[str], GarminSession]


def login(api: GarminApi, token_bundle: str, *, gap_s: float) -> GarminSession:
    # garminconnect reads a tokenstore that does not look like JSON as a file path; never let it.
    try:
        parsed = json.loads(token_bundle)
    except ValueError:
        parsed = None
    if not isinstance(parsed, dict):
        raise auth_expired()
    session = GarminSession(api, gap_s=gap_s, sent_bundle=token_bundle)
    # Registered before login runs: its refresh can rotate the tokens, its profile load then fail.
    remember_login(session)
    session.call(api.login, tokenstore=token_bundle)
    return session


def connect_real(token_bundle: str) -> GarminSession:
    return login(
        Garmin(retry_attempts=GARMIN_RETRY_ATTEMPTS), token_bundle, gap_s=GARMIN_CALL_GAP_S
    )


def connect_fixture(token_bundle: str) -> GarminSession:
    # No network behind the fake, so no gap either: e2e and API tests stay fast.
    return login(FakeGarmin(), token_bundle, gap_s=0.0)


def connector_for(*, fixtures: bool) -> Connect:
    return connect_fixture if fixtures else connect_real


def get_connect(request: Request) -> Connect:
    connect: Connect = request.app.state.connect
    return connect


ConnectDep = Annotated[Connect, Depends(get_connect)]
