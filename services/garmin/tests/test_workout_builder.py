"""garmin_service.workouts.build_workout: the contract's workout as garminconnect's RunningWorkout.

The steps are pinned to the library's own create_*_step helpers, whose output spike 2 put on a
watch with its pace targets (spikes/garmin/spike2_workout.py).
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from garminconnect.workout import (
    PaceTarget,
    RunningWorkout,
    create_cooldown_step,
    create_distance_interval_step,
    create_recovery_step,
    create_repeat_group,
    create_targeted_distance_interval_step,
    create_targeted_interval_step,
    create_warmup_step,
    pace_to_mps,
)
from pydantic import ValidationError

from garmin_service.models.workouts import GarminWorkout
from garmin_service.workouts import build_workout

# Spike 2's band, 5:00 to 5:20 per km.
SPIKE_PACE = {"fastSPerKm": 300, "slowSPerKm": 320}


def step(
    type_: str,
    *,
    duration_s: int | None = None,
    distance_m: int | None = None,
    pace: dict[str, int] | None = None,
) -> dict[str, Any]:
    return {"type": type_, "distanceM": distance_m, "durationS": duration_s, "pace": pace}


def workout(
    *steps: dict[str, Any], name: str = "Intervals 4 x 3 min", estimated: int = 2100
) -> Any:
    return GarminWorkout.model_validate(
        {"name": name, "estimatedDurationS": estimated, "steps": list(steps)}
    )


def built_steps(*steps: dict[str, Any]) -> list[dict[str, Any]]:
    built = build_workout(workout(*steps)).to_dict()
    [segment] = built["workoutSegments"]
    result: list[dict[str, Any]] = segment["workoutSteps"]
    return result


def dumped(*library_steps: Any) -> list[dict[str, Any]]:
    return [s.model_dump(exclude_none=True, mode="json") for s in library_steps]


def spike_target() -> PaceTarget:
    return PaceTarget(lower_limit=pace_to_mps(5, 20, "km"), upper_limit=pace_to_mps(5, 0, "km"))


def test_builds_spike_2s_workout_exactly_with_repeat_orders_running_on_through_the_children() -> (
    None
):
    built = built_steps(
        step("warmup", duration_s=600),
        {
            "repeat": 4,
            "steps": [
                step("interval", duration_s=180, pace=SPIKE_PACE),
                step("recovery", duration_s=120),
            ],
        },
        step("cooldown", duration_s=300),
    )

    assert built == dumped(
        create_warmup_step(600, step_order=1),
        create_repeat_group(
            4,
            [
                create_targeted_interval_step(180, 3, spike_target()),
                create_recovery_step(120, 4),
            ],
            step_order=2,
        ),
        create_cooldown_step(300, step_order=5),
    )


def test_numbers_steps_consecutively_across_two_repeat_groups() -> None:
    built = built_steps(
        step("warmup", duration_s=600),
        {"repeat": 3, "steps": [step("interval", distance_m=400), step("recovery", duration_s=90)]},
        step("recovery", duration_s=300),
        {"repeat": 2, "steps": [step("interval", distance_m=1000)]},
        step("cooldown", duration_s=600),
    )

    orders = [
        (s["stepOrder"], [child["stepOrder"] for child in s.get("workoutSteps", [])]) for s in built
    ]
    assert orders == [(1, []), (2, [3, 4]), (5, []), (6, [7]), (8, [])]
    assert [s["type"] for s in built] == [
        "ExecutableStepDTO",
        "RepeatGroupDTO",
        "ExecutableStepDTO",
        "RepeatGroupDTO",
        "ExecutableStepDTO",
    ]
    assert (built[1]["numberOfIterations"], built[3]["numberOfIterations"]) == (3, 2)


def test_a_time_step_ends_after_its_seconds() -> None:
    [warmup, recovery, cooldown] = built_steps(
        step("warmup", duration_s=900),
        step("recovery", duration_s=60),
        step("cooldown", duration_s=420),
    )

    assert [warmup, recovery, cooldown] == dumped(
        create_warmup_step(900, step_order=1),
        create_recovery_step(60, 2),
        create_cooldown_step(420, 3),
    )
    assert warmup["endCondition"]["conditionTypeKey"] == "time"
    assert warmup["endConditionValue"] == 900.0


def test_a_distance_step_ends_after_its_meters() -> None:
    [open_run, paced_run] = built_steps(
        step("interval", distance_m=5000),
        step("interval", distance_m=800, pace=SPIKE_PACE),
    )

    assert [open_run, paced_run] == dumped(
        create_distance_interval_step(5000, 1),
        create_targeted_distance_interval_step(800, 2, spike_target()),
    )
    assert open_run["endCondition"] == {
        "conditionTypeId": 3,
        "conditionTypeKey": "distance",
        "displayOrder": 3,
        "displayable": True,
    }
    assert paced_run["endConditionValue"] == 800.0


@pytest.mark.parametrize("type_", ["warmup", "recovery", "cooldown"])
def test_a_distance_step_of_any_type_keeps_its_type(type_: str) -> None:
    [built] = built_steps(step(type_, distance_m=1500))

    assert built["stepType"]["stepTypeKey"] == type_
    assert built["endCondition"]["conditionTypeKey"] == "distance"
    assert built["endConditionValue"] == 1500.0


def test_a_pace_band_becomes_a_pace_zone_in_meters_per_second_slower_pace_as_lower_limit() -> None:
    [built] = built_steps(
        step("interval", duration_s=1200, pace={"fastSPerKm": 250, "slowSPerKm": 400})
    )

    assert built["targetType"] == {
        "workoutTargetTypeId": 6,
        "workoutTargetTypeKey": "pace.zone",
        "displayOrder": 1,
    }
    assert built["targetValueOne"] == pytest.approx(2.5)  # 1000 m / 400 s
    assert built["targetValueTwo"] == pytest.approx(4.0)  # 1000 m / 250 s
    assert built["targetValueOne"] < built["targetValueTwo"]


def test_a_single_pace_band_gives_equal_limits() -> None:
    [built] = built_steps(
        step("interval", duration_s=600, pace={"fastSPerKm": 300, "slowSPerKm": 300})
    )

    assert built["targetValueOne"] == built["targetValueTwo"] == pytest.approx(1000 / 300)


def test_a_paced_warmup_gets_the_target_too() -> None:
    [built] = built_steps(step("warmup", duration_s=600, pace=SPIKE_PACE))

    assert built["stepType"]["stepTypeKey"] == "warmup"
    assert built["targetType"]["workoutTargetTypeKey"] == "pace.zone"
    assert built["targetValueOne"] == pytest.approx(1000 / 320)


@pytest.mark.parametrize("type_", ["warmup", "interval", "recovery", "cooldown"])
def test_an_open_step_has_no_target(type_: str) -> None:
    [built] = built_steps(step(type_, duration_s=300))

    assert built["targetType"] == {
        "workoutTargetTypeId": 1,
        "workoutTargetTypeKey": "no.target",
        "displayOrder": 1,
    }
    assert "targetValueOne" not in built
    assert "targetValueTwo" not in built


def test_builds_one_running_segment_with_the_name_and_estimated_duration() -> None:
    built = build_workout(
        workout(step("interval", distance_m=5000), name="Easy Run 5 km", estimated=1800)
    )

    assert isinstance(built, RunningWorkout)
    payload = built.to_dict()
    assert payload["workoutName"] == "Easy Run 5 km"
    assert payload["estimatedDurationInSecs"] == 1800
    running = {"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}
    assert payload["sportType"] == running
    [segment] = payload["workoutSegments"]
    assert segment["segmentOrder"] == 1
    assert segment["sportType"] == running
    # What upload_workout posts must be plain JSON.
    assert json.loads(json.dumps(payload)) == payload


@pytest.mark.parametrize(
    "bad_step",
    [
        step("interval", duration_s=60, distance_m=200),
        step("interval"),
        step("interval", duration_s=0),
        step("interval", duration_s=60, pace={"fastSPerKm": 330, "slowSPerKm": 300}),
        step("strides", duration_s=60),
        {"repeat": 1, "steps": [step("interval", duration_s=60)]},
        {"repeat": 3, "steps": []},
    ],
)
def test_the_model_rejects_what_the_contract_rejects(bad_step: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        workout(bad_step)
