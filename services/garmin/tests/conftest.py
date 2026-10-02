from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from garmin_service.config import Settings
from tests.helpers import TEST_SECRET

# garmin_service.main builds its module-level app from the environment when first imported.
os.environ.setdefault("GARMIN_SERVICE_SECRET", TEST_SECRET)

AppFactory = Callable[..., TestClient]


@pytest.fixture
def make_client() -> Iterator[AppFactory]:
    """Builds a TestClient for a fresh app. Keyword arguments go to create_app."""
    from garmin_service.main import create_app

    clients: list[TestClient] = []

    def factory(secret_header: str | None = TEST_SECRET, **kwargs: Any) -> TestClient:
        settings = kwargs.pop("settings", Settings(secret=TEST_SECRET, fixtures=True))
        headers = {} if secret_header is None else {"x-garmin-secret": secret_header}
        client = TestClient(create_app(settings, **kwargs), headers=headers)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client: AppFactory) -> TestClient:
    """Fixture mode (the fake serving tests/fixtures) with the right secret."""
    return make_client()
