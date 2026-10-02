"""tests/sanitize.py: raw Garmin responses become fixtures with nothing personal left."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tests.helpers import FIXTURES_DIR
from tests.sanitize import FIXTURE_EMAIL, FIXTURE_URL, main, sanitize

# Shaped like Garmin's activity list; every value here is invented.
RAW: list[dict[str, Any]] = [
    {
        "activityId": 987654321099,
        "activityUUID": "f3b1c2d4-0000-4000-8000-aaaaaaaaaaaa",
        "activityName": "Riverside Loop with Sam",
        "description": "felt sore after",
        "startTimeLocal": "2026-09-02 07:00:00",
        "activityType": {"typeId": 1, "typeKey": "running", "parentTypeId": 17},
        "ownerId": 55501,
        "ownerDisplayName": "jane.doe.42",
        "ownerFullName": "Jane Doe",
        "ownerProfileImageUrlLarge": "https://img.example.org/jane.png",
        "locationName": "Springfield",
        "startLatitude": 12.345,
        "startLongitude": 67.89,
        "deviceId": 444555666,
        "timeZoneId": 124,
        "sportTypeId": 1,
        "hasPolyline": True,
        "summaryId": 31337,
        "splitSummaries": [{"splitType": "INTERVAL_ACTIVE", "distance": 1000.0}],
        "geoPolylineDTO": {"polyline": [{"lat": 1.0, "lon": 2.0}]},
        "contact": "jane@example.org",
        "link": "http://tracker.example.org/u/jane",
    },
    {
        "activityId": 987654321000,
        "activityName": "Morning Run",
        "ownerId": 55501,
        "deviceId": 444555666,
        "userRoles": ["SCOPE_GOLF_API_READ"],
    },
]
PROFILE: dict[str, Any] = {
    "profileId": 55501,
    "displayName": "jane.doe.42",
    "fullName": "Jane Doe",
    "userName": "jane@example.org",
    "garminGUID": "c0ffee00-1111-2222-3333-444444444444",
    "emailAddress": "jane@example.org",
    "location": "Springfield",
    "bio": "I run.",
    "profileImageUrlSmall": "https://img.example.org/jane-small.png",
    "favoriteActivityTypes": ["running"],
}


def test_renumbers_ids_per_kind_keeping_order_and_links() -> None:
    newer, older = sanitize(RAW)

    assert older["activityId"] == 10_000_000_001
    assert newer["activityId"] == 10_000_000_002
    assert newer["ownerId"] == older["ownerId"] == 100_001
    assert newer["deviceId"] == older["deviceId"] == 3_000_000_001
    assert newer["summaryId"] == 7_000_000_001
    assert newer["activityUUID"] == "00000000-0000-4000-8000-000000000001"


def test_keeps_enumeration_ids_flags_and_metrics() -> None:
    newer, _ = sanitize(RAW)

    assert newer["activityType"] == {"typeId": 1, "typeKey": "running", "parentTypeId": 17}
    assert (newer["timeZoneId"], newer["sportTypeId"], newer["hasPolyline"]) == (124, 1, True)
    assert newer["splitSummaries"] == RAW[0]["splitSummaries"]
    assert newer["startTimeLocal"] == "2026-09-02 07:00:00"


def test_replaces_names_free_text_emails_and_urls() -> None:
    newer, older = sanitize(RAW)

    assert (newer["activityName"], older["activityName"]) == ("Activity 1", "Activity 2")
    assert newer["ownerDisplayName"] == "fixture-runner"
    assert newer["ownerFullName"] == "Alex Fixture"
    assert newer["description"] == "Fixture"
    assert newer["contact"] == FIXTURE_EMAIL
    assert newer["link"] == FIXTURE_URL


def test_removes_locations_coordinates_polylines_and_profile_images() -> None:
    newer, _ = sanitize(RAW)

    for key in (
        "locationName",
        "startLatitude",
        "startLongitude",
        "geoPolylineDTO",
        "ownerProfileImageUrlLarge",
    ):
        assert key not in newer


def test_sanitizes_a_social_profile() -> None:
    profile = sanitize(PROFILE)

    assert profile == {
        "profileId": 100_001,
        "displayName": "fixture-runner",
        "fullName": "Alex Fixture",
        "userName": "fixture-runner",
        "garminGUID": "00000000-0000-4000-8000-000000000001",
        "bio": "Fixture",
        "favoriteActivityTypes": ["running"],
    }


def test_leaves_nothing_of_the_raw_personal_values() -> None:
    text = json.dumps([sanitize(RAW), sanitize(PROFILE)])

    for value in ("Jane", "jane", "Springfield", "Sam", "sore", "12.345", "987654321", "444555666"):
        assert value not in text


def test_is_a_fixed_point_on_its_own_output() -> None:
    once = sanitize(RAW)

    assert sanitize(once) == once


@pytest.mark.parametrize("name", sorted(p.name for p in FIXTURES_DIR.glob("*.json")))
def test_committed_fixtures_are_already_sanitized(name: str) -> None:
    fixture = json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))

    assert sanitize(fixture) == fixture


def test_cli_writes_the_sanitized_fixture(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.json"
    out_path = tmp_path / "fixture.json"
    raw_path.write_text(json.dumps(RAW), encoding="utf-8")

    assert main([str(raw_path), "-o", str(out_path)]) == 0

    written = out_path.read_text(encoding="utf-8")
    assert json.loads(written) == sanitize(RAW)
    assert written.endswith("\n")


def test_cli_prints_to_stdout_without_an_output_path(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    raw_path = tmp_path / "raw.json"
    raw_path.write_text(json.dumps(PROFILE), encoding="utf-8")

    main([str(raw_path)])

    assert json.loads(capsys.readouterr().out) == sanitize(PROFILE)
