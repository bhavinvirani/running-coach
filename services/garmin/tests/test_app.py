"""main.py and config.py: the secret guard, request ids, logs, settings and the parent watchdog."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import pytest

from garmin_service.config import ConfigError, Settings
from garmin_service.main import parent_alive, watch_parent
from tests.conftest import AppFactory
from tests.helpers import TEST_SECRET, ScriptedGarmin, bundle

# Far above any pid_max on Linux (2^22) and macOS (99998).
DEAD_PID = 99_999_999


def log_lines(output: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in output.splitlines() if line.strip()]


def test_health_answers_ok_with_the_secret(client: Any) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/health", "/does-not-exist", "/docs", "/openapi.json"])
@pytest.mark.parametrize("secret", [None, "wrong", TEST_SECRET + "x", ""])
def test_answers_401_problem_before_anything_else_without_the_right_secret(
    make_client: AppFactory, path: str, secret: str | None
) -> None:
    response = make_client(secret_header=secret).get(path)

    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "unauthorized"


def test_unknown_paths_and_methods_get_problem_json(client: Any) -> None:
    missing = client.get("/does-not-exist")
    wrong_method = client.get("/sync")

    assert (missing.status_code, missing.json()["code"]) == (404, "not_found")
    assert (wrong_method.status_code, wrong_method.json()["code"]) == (405, "not_found")
    assert missing.headers["content-type"] == "application/problem+json"


def test_echoes_a_sane_request_id_and_puts_it_in_problems(client: Any) -> None:
    response = client.post("/profile", json={}, headers={"x-request-id": "req-123"})

    assert response.headers["x-request-id"] == "req-123"
    assert response.json()["requestId"] == "req-123"


@pytest.mark.parametrize("incoming", [None, "", "has spaces", "x" * 200, "semi;colon"])
def test_generates_a_request_id_when_the_incoming_one_is_missing_or_odd(
    client: Any, incoming: str | None
) -> None:
    headers = {} if incoming is None else {"x-request-id": incoming}

    response = client.get("/health", headers=headers)

    generated = response.headers["x-request-id"]
    assert generated
    assert generated != incoming


def test_logs_json_lines_with_the_request_id_and_never_the_bundle_or_name(
    client: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    capsys.readouterr()
    sent = bundle()
    client.post("/profile", json={"tokenBundle": sent}, headers={"x-request-id": "req-log"})
    client.post(
        "/sync",
        json={"tokenBundle": sent, "startDate": "2026-08-31", "endDate": "2026-09-27"},
        headers={"x-request-id": "req-log"},
    )

    output = capsys.readouterr().out
    lines = log_lines(output)
    request_lines = [line for line in lines if line["msg"] == "request"]
    assert {line["path"] for line in request_lines} == {"/profile", "/sync"}
    assert all(line["request_id"] == "req-log" for line in request_lines)
    for secret in ("fixture-token", "fixture-refresh", "Alex Fixture", TEST_SECRET, "18000"):
        assert secret not in output


def test_logs_a_rejected_health_check_but_not_a_passing_one(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    make_client().get("/health", headers={"x-request-id": "ok-check"})
    make_client(secret_header="wrong").get("/health", headers={"x-request-id": "bad-check"})

    ids = {line.get("request_id") for line in log_lines(capsys.readouterr().out)}
    assert "bad-check" in ids
    assert "ok-check" not in ids


def test_answers_500_internal_without_leaking_the_message(
    make_client: AppFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    garmin = ScriptedGarmin(login_error=RuntimeError("secret detail fixture-token"))

    response = make_client(connect=garmin.connect()).post(
        "/profile", json={"tokenBundle": bundle()}
    )

    assert response.status_code == 500
    assert response.json()["code"] == "internal"
    assert "secret detail" not in response.text
    output = capsys.readouterr().out
    assert "secret detail" not in output
    error_line = next(line for line in log_lines(output) if line["msg"] == "unhandled error")
    assert error_line["error_type"] == "RuntimeError"
    assert error_line["stack"]


def test_settings_require_the_secret_and_parse_the_rest() -> None:
    with pytest.raises(ConfigError, match="GARMIN_SERVICE_SECRET"):
        Settings.from_env({})
    with pytest.raises(ConfigError, match="GARMIN_SERVICE_SECRET"):
        Settings.from_env({"GARMIN_SERVICE_SECRET": "   "})

    settings = Settings.from_env(
        {
            "GARMIN_SERVICE_SECRET": "s3cret",
            "GARMIN_FIXTURES": "1",
            "LOG_LEVEL": "warn",
            "GARMIN_PARENT_PID": "4242",
        }
    )

    assert settings == Settings(
        secret="s3cret", fixtures=True, log_level=logging.WARNING, parent_pid=4242
    )
    assert "s3cret" not in repr(settings)


@pytest.mark.parametrize(
    ("name", "value"),
    [("GARMIN_FIXTURES", "yes"), ("LOG_LEVEL", "loud"), ("GARMIN_PARENT_PID", "-1")],
)
def test_settings_reject_invalid_values(name: str, value: str) -> None:
    with pytest.raises(ConfigError, match=name):
        Settings.from_env({"GARMIN_SERVICE_SECRET": "s", name: value})


def test_settings_default_to_live_garmin_at_info_without_a_watchdog() -> None:
    settings = Settings.from_env({"GARMIN_SERVICE_SECRET": "s"})

    assert (settings.fixtures, settings.log_level, settings.parent_pid) == (
        False,
        logging.INFO,
        None,
    )


def test_parent_alive_tells_a_running_process_from_a_gone_one() -> None:
    assert parent_alive(os.getpid()) is True
    assert parent_alive(DEAD_PID) is False


def test_watchdog_calls_on_gone_once_the_parent_exits() -> None:
    calls: list[str] = []

    asyncio.run(watch_parent(DEAD_PID, lambda: calls.append("gone"), interval_s=0.01))

    assert calls == ["gone"]


def test_app_with_a_live_parent_starts_and_stops_cleanly(make_client: AppFactory) -> None:
    settings = Settings(secret=TEST_SECRET, fixtures=True, parent_pid=os.getpid())

    response = make_client(settings=settings).get("/health")

    assert response.status_code == 200
