"""Turn a raw Garmin response into a committable fixture. The repo is public: no real data.

    uv run python -m tests.sanitize raw/<name>.json -o tests/fixtures/<name>.json

Raw captures live only in services/garmin/raw/, which git ignores.

Ids are renumbered per kind, keeping their order (a newer activity keeps the larger id) and the
links between them (ownerId and profileId of one person stay equal); serial numbers are
renumbered the same way. Person names, free text, emails and URLs are replaced; birthDate, age,
gender, weight and height become fixed fakes wherever they appear; locations, coordinates,
polylines and profile images are removed. The output is a fixed point: sanitizing a fixture again
returns it unchanged.

Kept as they are, so read the result for them before committing it: timestamps and dates
(startTimeLocal, startTimeGMT, beginTimestamp, ...), heart rate, cadence, pace, speed, distance,
duration, elevation, calories and every other metric, and enumeration ids (typeId, *TypeId,
timeZoneId).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

_ID_KINDS: dict[str, tuple[str, ...]] = {
    "activity": ("activityId", "parentId"),
    "user": ("ownerId", "profileId", "userProfileId", "userProfilePK", "userProfilePk", "userId"),
    "device": ("deviceId", "userDeviceId", "unitId"),
    "workout": ("workoutId",),
}
_ID_BASES = {
    "activity": 10_000_000_000,
    "user": 100_000,
    "device": 3_000_000_000,
    "workout": 5_000_000_000,
    "other": 7_000_000_000,
}
_KIND_OF = {key: kind for kind, keys in _ID_KINDS.items() for key in keys}
_ENUM_ID_KEYS = frozenset({"typeId", "timeZoneId"})

PERSON_NAMES = {
    "displayName": "fixture-runner",
    "ownerDisplayName": "fixture-runner",
    "userName": "fixture-runner",
    "fullName": "Alex Fixture",
    "ownerFullName": "Alex Fixture",
    "userProfileFullName": "Alex Fixture",
    "firstName": "Alex",
    "lastName": "Fixture",
}
# Garmin reports weight in grams and height in centimetres.
PROFILE_FAKES: dict[str, Any] = {
    "birthDate": "1990-01-01",
    "age": 36,
    "gender": "FEMALE",
    "weight": 70000.0,
    "height": 175.0,
}
_FREE_TEXT_KEYS = frozenset({"description", "bio", "motivation", "notes", "comment"})
_REMOVED_KEYS = frozenset({"location", "locationName", "lat", "lon", "lng"})
# profileImg: the workout author's profileImgNameSmall and friends, file names built on a uuid.
_REMOVED_FRAGMENTS = ("latitude", "longitude", "polyline", "profileimage", "profileimg", "email")

FIXTURE_EMAIL = "runner@example.com"
FIXTURE_URL = "https://example.com/"
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_URL = re.compile(r"https?://", re.IGNORECASE)


def _is_removed(key: str, value: Any) -> bool:
    if isinstance(value, bool):
        return False  # flags such as hasPolyline say nothing about the runner
    lowered = key.lower()
    return key in _REMOVED_KEYS or any(fragment in lowered for fragment in _REMOVED_FRAGMENTS)


def _id_kind(key: str, value: Any) -> str | None:
    if type(value) is not int or key in _ENUM_ID_KEYS or key.endswith("TypeId"):
        return None
    if key in _KIND_OF:
        return _KIND_OF[key]
    return "other" if key.endswith(("Id", "ID", "Pk", "PK")) or _is_serial_key(key) else None


def _is_uuid_key(key: str) -> bool:
    return key.endswith(("UUID", "Uuid", "GUID", "Guid"))


def _is_serial_key(key: str) -> bool:
    return key.lower().endswith(("serialnumber", "serial"))


def _walk(node: Any, visit: Callable[[str, Any], None], key: str | None = None) -> None:
    """Visit every scalar with its nearest key, skipping removed keys, in document order."""
    if isinstance(node, dict):
        for child_key, value in node.items():
            if not _is_removed(child_key, value):
                _walk(value, visit, child_key)
    elif isinstance(node, list):
        for item in node:
            _walk(item, visit, key)
    elif key is not None:
        visit(key, node)


def sanitize(raw: Any) -> Any:
    """Return a sanitized deep copy of a raw Garmin JSON value."""
    ids: dict[str, set[int]] = {}
    uuids: set[str] = set()
    serials: set[str] = set()

    def collect(key: str, value: Any) -> None:
        kind = _id_kind(key, value)
        if kind is not None:
            ids.setdefault(kind, set()).add(value)
        elif _is_uuid_key(key) and isinstance(value, str):
            uuids.add(value)
        elif _is_serial_key(key) and isinstance(value, str):
            serials.add(value)

    _walk(raw, collect)
    id_map = {
        kind: {old: _ID_BASES[kind] + i for i, old in enumerate(sorted(values), start=1)}
        for kind, values in ids.items()
    }
    uuid_map = {
        old: f"00000000-0000-4000-8000-{i:012d}" for i, old in enumerate(sorted(uuids), start=1)
    }
    serial_map = {old: f"{i:010d}" for i, old in enumerate(sorted(serials), start=1)}
    activity_names = 0

    def clean(key: str | None, value: Any) -> Any:
        nonlocal activity_names
        if isinstance(value, dict):
            return {k: clean(k, v) for k, v in value.items() if not _is_removed(k, v)}
        if isinstance(value, list):
            return [clean(key, item) for item in value]
        if key is None:
            return value
        kind = _id_kind(key, value)
        if kind is not None:
            return id_map[kind][value]
        if key in PROFILE_FAKES and value is not None:
            return PROFILE_FAKES[key]
        if not isinstance(value, str):
            return value
        if _is_uuid_key(key):
            return uuid_map[value]
        if _is_serial_key(key):
            return serial_map[value]
        if key in PERSON_NAMES:
            return PERSON_NAMES[key]
        if key == "activityName":
            activity_names += 1
            return f"Activity {activity_names}"
        if key in _FREE_TEXT_KEYS or key.endswith("Name"):
            return "Fixture"
        if _EMAIL.fullmatch(value.strip()):
            return FIXTURE_EMAIL
        if _URL.match(value.strip()):
            return FIXTURE_URL
        return value

    return clean(None, raw)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sanitize a raw Garmin response into a fixture.")
    parser.add_argument("raw", type=Path, help="raw Garmin JSON (never commit it)")
    parser.add_argument("-o", "--out", type=Path, help="fixture path; stdout when left out")
    args = parser.parse_args(argv)
    sanitized = sanitize(json.loads(args.raw.read_text(encoding="utf-8")))
    text = json.dumps(sanitized, indent=2, ensure_ascii=False) + "\n"
    if args.out is None:
        sys.stdout.write(text)
    else:
        args.out.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
