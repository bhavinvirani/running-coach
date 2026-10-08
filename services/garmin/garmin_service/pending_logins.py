"""The one state this service keeps: a password login waiting for its 2FA code.

/connect keeps the live Garmin instance (its MFA state is an HTTP session that cannot be serialized)
under the caller's loginId, one per id, a new start replacing the old one, for LOGIN_TTL_S from the
start and at most MAX_CODES refused codes. Process memory only, nothing on disk: a restart or a
deploy empties it and the next code answers garmin_login_lost. uvicorn runs one process (the API
starts it without --workers), so every request sees the same store.

Sync routes run in the threadpool, so the map has its own lock, and each login a lock of its own:
resume_login never runs twice at once on one instance, and a second code waits for the first.
Expired logins are swept on every access.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Annotated

from fastapi import Depends, Request

from garmin_service.errors import login_lost
from garmin_service.password_login import PasswordLogin

# Long enough to open the email with the code; a forgotten login does not linger.
LOGIN_TTL_S = 300.0
# Refused codes per login: a typo costs no new password login, guessing gets nowhere.
MAX_CODES = 3


class PendingLogin:
    """One login waiting for its code. Its lock is held while a code is checked."""

    def __init__(self, garmin: PasswordLogin, started: float) -> None:
        self.garmin = garmin
        self.started = started
        self.refused_codes = 0
        self.lock = threading.Lock()


class PendingLogins:
    def __init__(
        self, *, clock: Callable[[], float] = time.monotonic, ttl_s: float = LOGIN_TTL_S
    ) -> None:
        self._clock = clock
        self._ttl_s = ttl_s
        self._lock = threading.Lock()
        self._logins: dict[str, PendingLogin] = {}

    def __len__(self) -> int:
        with self._lock:
            self._sweep()
            return len(self._logins)

    def put(self, login_id: str, garmin: PasswordLogin) -> None:
        """Keep a login that waits for its code, replacing any other under the same id."""
        with self._lock:
            self._sweep()
            self._logins[login_id] = PendingLogin(garmin, self._clock())

    def discard(self, login_id: str) -> None:
        """Forget the login under this id, if any: a new start replaces it whatever its outcome."""
        with self._lock:
            self._sweep()
            self._logins.pop(login_id, None)

    def drop(self, login_id: str, pending: PendingLogin) -> None:
        """Forget this login, unless a new start has replaced it meanwhile."""
        with self._lock:
            if self._logins.get(login_id) is pending:
                del self._logins[login_id]

    @contextmanager
    def checkout(self, login_id: str) -> Iterator[PendingLogin]:
        """The login under this id, held for one code; garmin_login_lost when there is none."""
        pending = self._current(login_id)
        if pending is None:
            raise login_lost()
        with pending.lock:
            # While this request waited, the code before it may have finished or dropped the login,
            # a new start replaced it, or its time ran out.
            if self._current(login_id) is not pending:
                raise login_lost()
            yield pending

    def _current(self, login_id: str) -> PendingLogin | None:
        with self._lock:
            self._sweep()
            return self._logins.get(login_id)

    def _sweep(self) -> None:
        now = self._clock()
        expired = [key for key, p in self._logins.items() if now - p.started >= self._ttl_s]
        for key in expired:
            del self._logins[key]


def get_pending_logins(request: Request) -> PendingLogins:
    logins: PendingLogins = request.app.state.pending_logins
    return logins


PendingLoginsDep = Annotated[PendingLogins, Depends(get_pending_logins)]
