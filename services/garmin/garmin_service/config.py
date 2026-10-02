"""Settings from the environment the API passes when it spawns this service, read once at boot."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field

# LOG_LEVEL uses the API's pino names; Python names are accepted too.
_LOG_LEVELS: dict[str, int] = {
    "trace": logging.DEBUG,
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "fatal": logging.CRITICAL,
    "critical": logging.CRITICAL,
    "silent": logging.CRITICAL + 10,
}


class ConfigError(ValueError):
    """A missing or invalid variable. The message names the variable, never its value."""


@dataclass(frozen=True, slots=True)
class Settings:
    secret: str = field(repr=False)
    fixtures: bool = False
    log_level: int = logging.INFO
    parent_pid: int | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> Settings:
        secret = env.get("GARMIN_SERVICE_SECRET", "")
        if not secret.strip():
            raise ConfigError("GARMIN_SERVICE_SECRET is required")

        fixtures_raw = env.get("GARMIN_FIXTURES", "0").strip() or "0"
        if fixtures_raw not in ("0", "1"):
            raise ConfigError('GARMIN_FIXTURES must be "0" or "1"')

        level_raw = env.get("LOG_LEVEL", "info").strip().lower() or "info"
        if level_raw not in _LOG_LEVELS:
            raise ConfigError(f"LOG_LEVEL must be one of {', '.join(_LOG_LEVELS)}")

        pid_raw = env.get("GARMIN_PARENT_PID", "").strip()
        parent_pid: int | None = None
        if pid_raw:
            if not pid_raw.isdigit() or int(pid_raw) < 1:
                raise ConfigError("GARMIN_PARENT_PID must be a positive integer")
            parent_pid = int(pid_raw)

        return cls(
            secret=secret,
            fixtures=fixtures_raw == "1",
            log_level=_LOG_LEVELS[level_raw],
            parent_pid=parent_pid,
        )
