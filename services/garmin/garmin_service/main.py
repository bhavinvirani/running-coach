"""The Garmin service app. The API spawns it as a child process:

    .venv/bin/uvicorn garmin_service.main:app --host 127.0.0.1 --port $GARMIN_SERVICE_PORT

with GARMIN_SERVICE_SECRET, GARMIN_FIXTURES, LOG_LEVEL and GARMIN_PARENT_PID in the environment.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import os
import re
import signal
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from fastapi import FastAPI
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from garmin_service.client import Connect, connector_for
from garmin_service.config import Settings
from garmin_service.errors import (
    install_error_handlers,
    internal_error_response,
    unauthorized_response,
)
from garmin_service.log import configure_logging, request_id_var
from garmin_service.routes import profile, sync

log = logging.getLogger(__name__)

PARENT_POLL_S = 1.0
# uvicorn finishes in-flight requests on SIGTERM; a hung Garmin call must not keep the port.
SHUTDOWN_GRACE_S = 10.0
_SANE_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")


class GuardMiddleware:
    """Outermost layer: request id, shared-secret check, access log, last-resort 500.

    The secret is checked before any other work, for every path including /health and unknown ones.
    """

    def __init__(self, app: ASGIApp, secret: str) -> None:
        self.app = app
        self._secret = secret.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":
            await send({"type": "websocket.close", "code": 1008})
            return

        headers = Headers(scope=scope)
        incoming_id = headers.get("x-request-id", "")
        request_id = incoming_id if _SANE_REQUEST_ID.fullmatch(incoming_id) else str(uuid.uuid4())
        context_token = request_id_var.set(request_id)
        started = time.perf_counter()
        status = 500
        response_started = False

        async def send_with_request_id(message: Message) -> None:
            nonlocal status, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status = message["status"]
                MutableHeaders(scope=message).append("x-request-id", request_id)
            await send(message)

        try:
            provided = headers.get("x-garmin-secret", "").encode("latin-1")
            if not hmac.compare_digest(provided, self._secret):
                await unauthorized_response()(scope, receive, send_with_request_id)
                return
            try:
                await self.app(scope, receive, send_with_request_id)
            except Exception as exc:
                if response_started:
                    raise
                await internal_error_response(exc)(scope, receive, send_with_request_id)
        finally:
            quiet = scope["path"] == "/health" and status < 400  # the API polls it
            log.log(
                logging.DEBUG if quiet else logging.INFO,
                "request",
                extra={
                    "method": scope["method"],
                    "path": scope["path"],
                    "status": status,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )
            request_id_var.reset(context_token)


def parent_alive(pid: int) -> bool:
    # Re-parented to init or launchd: the API that spawned us is gone, even if its pid was reused.
    if pid != 1 and os.getppid() == 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def watch_parent(
    pid: int, on_gone: Callable[[], None], interval_s: float = PARENT_POLL_S
) -> None:
    """Calls on_gone once the parent process exits, so a restarted API never meets an orphan."""
    while parent_alive(pid):
        await asyncio.sleep(interval_s)
    log.warning("parent process is gone, shutting down", extra={"parent_pid": pid})
    on_gone()


def _shut_down() -> None:
    asyncio.get_running_loop().call_later(SHUTDOWN_GRACE_S, os._exit, 0)
    signal.raise_signal(signal.SIGTERM)


def _lifespan(settings: Settings) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        watchdog = None
        if settings.parent_pid is not None:
            watchdog = asyncio.create_task(watch_parent(settings.parent_pid, _shut_down))
        log.info("garmin service ready", extra={"fixtures": settings.fixtures})
        try:
            yield
        finally:
            if watchdog is not None:
                watchdog.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await watchdog

    return lifespan


def health() -> dict[str, str]:
    return {"status": "ok"}


def create_app(settings: Settings, *, connect: Connect | None = None) -> FastAPI:
    configure_logging(settings.log_level)
    app = FastAPI(
        title="garmin-service",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan(settings),
    )
    app.state.connect = connect or connector_for(fixtures=settings.fixtures)
    install_error_handlers(app)
    app.add_api_route("/health", health, methods=["GET"])
    app.include_router(profile.router)
    app.include_router(sync.router)
    app.add_middleware(GuardMiddleware, secret=settings.secret)
    return app


app = create_app(Settings.from_env(os.environ))
