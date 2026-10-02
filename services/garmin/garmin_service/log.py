"""JSON-lines logging with the request id from x-request-id.

Never log the token bundle, email, password, MFA code or Garmin payloads: log ids, counts, status
codes and exception class names. Exception messages are dropped because library and pydantic
messages can quote payload values.
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

SERVICE_NAME = "garmin"

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

# Same labels as the API's pino logs so both streams read alike.
_LEVEL_LABELS = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "fatal",
}

# Attributes every LogRecord has; anything else on a record came from `extra=`.
_RECORD_ATTRS = frozenset(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
    "taskName",
    "color_message",  # uvicorn's ANSI-colored copy of msg
}

# Third-party loggers that would print request or response bodies at debug level.
_QUIET_LOGGERS = ("garminconnect", "urllib3", "requests", "curl_cffi", "httpx", "httpcore")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": _LEVEL_LABELS.get(record.levelno, record.levelname.lower()),
            "service": SERVICE_NAME,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id is not None:
            entry["request_id"] = request_id
        for key, value in vars(record).items():
            if key not in _RECORD_ATTRS and not key.startswith("_"):
                entry[key] = value
        if record.exc_info and record.exc_info[0] is not None:
            entry["error_type"] = record.exc_info[0].__name__
        return json.dumps(entry, default=str)


class _StdoutHandler(logging.StreamHandler[Any]):
    """Looks up sys.stdout on every write, so a replaced stdout (tests) still gets the lines."""

    def __init__(self) -> None:
        super().__init__(sys.stdout)

    def emit(self, record: logging.LogRecord) -> None:
        self.stream = sys.stdout  # not setStream(): that flushes the old, possibly closed, stream
        super().emit(record)


def configure_logging(level: int) -> None:
    """Route the root logger and uvicorn's loggers through one JSON handler on stdout."""
    handler = _StdoutHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
        uvicorn_logger.setLevel(level)
    # The guard middleware logs each request with its id; uvicorn's access line would repeat it.
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False
    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(max(level, logging.WARNING))
