"""Garmin's laps, sample rows, route and heart-rate zones of one run as the shared detail."""

import logging
from collections.abc import Sequence

from pydantic import BaseModel, TypeAdapter, ValidationError

from garmin_service.activities import positive
from garmin_service.errors import unavailable
from garmin_service.models.activity_detail import (
    ActivityDetail,
    ActivityLap,
    ActivityStreams,
    HrZoneTime,
)
from garmin_service.models.garmin import GarminDetails, GarminHrZone, GarminSplits

log = logging.getLogger(__name__)

# get_activity_details thins the run to at most this many rows and the route to this many points.
DETAIL_MAX_CHART = 2000
DETAIL_MAX_POLY = 4000

# Series in get_activity_details, by metricDescriptors key, in the units the contract uses.
ELAPSED_S = "sumDuration"  # timer seconds from the start
DISTANCE_M = "sumDistance"
HR_BPM = "directHeartRate"
# Both feet; directRunCadence counts one foot, about half of this.
CADENCE_SPM = "directDoubleCadence"
ELEVATION_M = "directElevation"
SPEED_MPS = "directSpeed"

HR_ZONE_COUNT = 5

# Timer seconds, distance in meters, and the whole row for the other series.
TimedRow = tuple[float, float, Sequence[float | None]]

_HR_ZONES = TypeAdapter(list[GarminHrZone])


def to_detail(splits: object, details: object, hr_zones: object) -> ActivityDetail:
    """The three library answers, as Garmin sent them, mapped to the shared detail."""
    parsed = parse_details(details)
    return ActivityDetail(
        laps=to_laps(_parse(GarminSplits, splits, "splits")),
        streams=to_streams(parsed),
        route=to_route(parsed),
        hr_zones=to_hr_zones(_parse_zones(hr_zones)),
    )


def to_laps(splits: GarminSplits) -> list[ActivityLap]:
    laps: list[ActivityLap] = []
    for position, lap in enumerate(splits.lap_dtos or [], start=1):
        index = lap.lap_index if lap.lap_index is not None and lap.lap_index >= 1 else position
        laps.append(
            ActivityLap(
                index=index,
                distance_m=max(lap.distance or 0.0, 0.0),
                duration_s=max(lap.duration or 0.0, 0.0),
                avg_hr=positive(lap.average_hr),
                avg_cadence=positive(lap.average_run_cadence),
            )
        )
    return laps


def parse_details(raw: object) -> GarminDetails:
    """get_activity_details as Garmin sent it; a shape this service cannot read is unavailable."""
    return _parse(GarminDetails, raw, "details")


def timed_rows(details: GarminDetails) -> list[TimedRow]:
    """Every sample row with its timer seconds and distance, in Garmin's order.

    Rows without a time or a distance are dropped: nothing can place them. None are left when
    Garmin holds no samples (detailsAvailable false, as for a manual entry) or lacks either column.
    """
    columns = _columns(details)
    rows = details.activity_detail_metrics or []
    if details.details_available is False or ELAPSED_S not in columns or DISTANCE_M not in columns:
        rows = []
    kept: list[TimedRow] = []
    for row in rows:
        metrics = row.metrics or []
        elapsed = _at(metrics, columns[ELAPSED_S])
        distance = _at(metrics, columns[DISTANCE_M])
        if elapsed is not None and distance is not None and elapsed >= 0 and distance >= 0:
            kept.append((elapsed, distance, metrics))
    return kept


def to_streams(details: GarminDetails) -> ActivityStreams:
    columns = _columns(details)
    kept = timed_rows(details)

    def series(key: str, keep: float | None = None) -> list[float | None] | None:
        """None when the watch did not record it; values below `keep` become missing samples."""
        if key not in columns:
            return None
        values = [_at(metrics, columns[key]) for _, _, metrics in kept]
        if keep is not None:
            values = [value if value is not None and value >= keep else None for value in values]
        return values if any(value is not None for value in values) else None

    return ActivityStreams(
        elapsed_s=[elapsed for elapsed, _, _ in kept],
        distance_m=[distance for _, distance, _ in kept],
        # 0 bpm is a sensor without contact, not a heart rate.
        hr=series(HR_BPM, keep=1.0),
        cadence=series(CADENCE_SPM, keep=0.0),
        elevation_m=series(ELEVATION_M),
        speed_mps=series(SPEED_MPS, keep=0.0),
    )


def to_route(details: GarminDetails) -> list[tuple[float, float]] | None:
    """[lat, lon] in order; points missing a coordinate are skipped. None when there is no track."""
    polyline = details.geo_polyline_dto.polyline if details.geo_polyline_dto is not None else None
    route: list[tuple[float, float]] = []
    for point in polyline or []:
        lat, lon = point.lat, point.lon
        if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
            route.append((lat, lon))
    return route or None


def to_hr_zones(zones: list[GarminHrZone]) -> list[HrZoneTime] | None:
    """Zones 1 to 5 in order; None when no zone holds a second (a run without heart rate)."""
    by_number: dict[int, GarminHrZone] = {}
    for zone in zones:
        if 1 <= zone.zone_number <= HR_ZONE_COUNT:
            by_number.setdefault(zone.zone_number, zone)
    mapped = [
        HrZoneTime(
            zone=number,
            low_bpm=max(zone.zone_low_boundary or 0.0, 0.0),
            seconds=max(zone.secs_in_zone or 0.0, 0.0),
        )
        for number, zone in sorted(by_number.items())
    ]
    return mapped if any(zone.seconds > 0 for zone in mapped) else None


def _columns(details: GarminDetails) -> dict[str, int]:
    """Column of each series by its descriptor key: rows are positional."""
    return {
        descriptor.key: descriptor.metrics_index for descriptor in details.metric_descriptors or []
    }


def _at(metrics: Sequence[float | None], index: int) -> float | None:
    return metrics[index] if index < len(metrics) else None


def _parse[M: BaseModel](model: type[M], raw: object, call: str) -> M:
    try:
        return model.model_validate(raw)
    except ValidationError as exc:
        raise _shape_changed(exc, call) from None


def _parse_zones(raw: object) -> list[GarminHrZone]:
    # The library answers {} when Garmin sends 204 No Content.
    if raw is None or raw == {}:
        return []
    try:
        return _HR_ZONES.validate_python(raw)
    except ValidationError as exc:
        raise _shape_changed(exc, "hr zones") from None


def _shape_changed(exc: ValidationError, call: str) -> Exception:
    # Where the shape broke, never the values: they are the runner's data.
    fields = [".".join(str(part) for part in error["loc"]) for error in exc.errors()]
    log.warning(
        "unexpected activity detail shape from Garmin", extra={"call": call, "fields": fields}
    )
    return unavailable()
