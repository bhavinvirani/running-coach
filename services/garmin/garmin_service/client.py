"""Builds the per-request Garmin client: the real garminconnect.Garmin, or the fixture fake.

Stateless by design: a client lives for one request and nothing is cached across requests.
Garmin().login(tokenstore=<bundle JSON>) loads the tokens, refreshes them when the access token is
within 15 minutes of expiry (the refresh token then rotates) and loads the social profile, so login
alone proves the bundle works. Routes return client.dumps() as the new bundle.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Annotated, Any, Protocol

from fastapi import Depends, Request
from garminconnect import Garmin

from garmin_service.errors import auth_expired
from garmin_service.fake_client import FakeGarmin

# At least this long between the end of one library call and the start of the next.
GARMIN_CALL_GAP_S = 1.0
# The library retries 5xx and network errors itself, with backoff and jitter, never 401 or 429.
# Retrying inside the session keeps a refresh token that login() just rotated; a retry from the
# API would start over with the old bundle.
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
    ) -> None:
        self.api = api
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
    session = GarminSession(api, gap_s=gap_s)
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
