"""Fixture mode (GARMIN_FIXTURES=1): a fake Garmin serving tests/fixtures/*.json, no network.

The token bundle drives the behaviour, so the API's integration tests and e2e reach every path
through the real service. Base bundle:
    {"di_token":"fixture-token","di_refresh_token":"fixture-refresh","di_client_id":"fixture-client"}
Add "fixture": "expired" (401 garmin_auth_expired), "rate_limited" (429), "unavailable" (502), or
"rotate" (success, and the returned bundle carries "fixture": "rotated"). Anything else succeeds
with the bundle unchanged. Failures are raised the way garminconnect's login() raises them, causes
chained, so errors.py runs exactly as in production.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from garminconnect import GarminConnectAuthenticationError, GarminConnectConnectionError

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

# What garminconnect's _run_request raises underneath login() for each simulated failure.
_LOGIN_FAILURES = {
    "expired": "API Error 401",
    "rate_limited": "API Error 429",
    "unavailable": "API Error 503",
}


class FakeTokenStore:
    def __init__(self) -> None:
        self.bundle = ""

    def dumps(self) -> str:
        return self.bundle


class FakeGarmin:
    def __init__(self, fixtures_dir: Path = FIXTURES_DIR) -> None:
        self._fixtures_dir = fixtures_dir
        self._tokens = FakeTokenStore()
        self.display_name: str | None = None
        self.full_name: str | None = None

    @property
    def client(self) -> FakeTokenStore:
        return self._tokens

    def login(self, /, tokenstore: str | None = None) -> tuple[str | None, str | None]:
        try:
            bundle = json.loads(tokenstore or "")
        except ValueError:
            bundle = None
        if not isinstance(bundle, dict) or not bundle.get("di_token"):
            # garminconnect's answer when the tokens do not load and there is no password.
            raise GarminConnectAuthenticationError("Username and password are required")

        behaviour = bundle.get("fixture")
        if isinstance(behaviour, str) and behaviour in _LOGIN_FAILURES:
            raise GarminConnectAuthenticationError(
                "Failed to retrieve social profile"
            ) from GarminConnectConnectionError(_LOGIN_FAILURES[behaviour])

        if behaviour == "rotate":
            self._tokens.bundle = json.dumps({**bundle, "fixture": "rotated"})
        else:
            self._tokens.bundle = tokenstore or ""

        profile = self._read("profile.json")
        if not isinstance(profile, dict):
            raise TypeError("profile.json must hold an object")
        self.display_name = profile.get("displayName")
        self.full_name = profile.get("fullName")
        return None, None

    def get_activities_by_date(
        self,
        startdate: str,
        enddate: str | None = None,
        activitytype: str | None = None,
        sortorder: str | None = None,
    ) -> list[dict[str, Any]]:
        # activitytype is ignored on purpose: the route's own running filter must hold by itself.
        items = self._read("sync.json")
        if not isinstance(items, list):
            raise TypeError("sync.json must hold a list")
        last = enddate or "9999-12-31"
        selected = [
            item
            for item in items
            if isinstance(item, dict) and startdate <= str(item["startTimeLocal"])[:10] <= last
        ]
        # Garmin's default order is newest first by startTimeLocal.
        selected.sort(key=lambda item: str(item["startTimeLocal"]), reverse=sortorder != "asc")
        return selected

    def _read(self, name: str) -> Any:
        return json.loads((self._fixtures_dir / name).read_text(encoding="utf-8"))
