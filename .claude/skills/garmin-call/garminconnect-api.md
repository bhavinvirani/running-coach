# garminconnect reference (verified in phase 2 spikes, 2026-10-01)

Library: `garminconnect` 0.3.x (Python 3.12+), native auth engine; `garth` is deprecated and unused.
Needs `pydantic` installed for the workout models (optional dependency of the library).

## Tokens

- Bundle: `garmin.client.dumps()` returns JSON `{di_token, di_refresh_token, di_client_id}`. Load with `Garmin().login(tokenstore=<json string>)`.
- Access token (`di_token`, JWT) lives about 24.6 h. Refresh token is opaque and ROTATES on every refresh.
- The library refreshes when the access token is under 15 min from expiry (`_token_expires_soon`, 900 s) and inside `login(tokenstore=...)`.
- Therefore: after every call, compare `dumps()` with the input bundle and write it back if changed; serialize all calls per user (two concurrent refreshes kill the bundle).
- Login from password: `Garmin(email, password, return_on_mfa=True).login()` returns `("needs_mfa", None)` when a code is needed; then `resume_login({}, code)`. The MFA state is a live HTTP session on the instance, not serializable.
- Garmin answered 429 to the library's mobile login fingerprints even from a home IP; the web-widget fallback inside `login()` succeeded. Login rarely, reuse tokens, never auto-retry 429 (blocks last about 1 h).

## Politeness

About 1 s between data calls; `get_activities_by_date` pages 20 at a time internally; `get_activities(start, limit)` up to 1000 per page.

## Methods used (all exercised in the spikes)

| Purpose | Call | Notes |
|---|---|---|
| List runs | `get_activities_by_date(start, end, "running", sortorder=None)` | Items: `activityId`, `activityType.typeKey` (treadmill_running, indoor_running, virtual_run are indoor), `startTimeLocal`, `distance` m, `duration` s, `averageHR` |
| List any | `get_activities(start, limit)` | Newest first |
| Summary | `get_activity(id)` | |
| Splits | `get_activity_splits(id)` -> `{"lapDTOs": [...]}`; `get_activity_typed_splits(id)` | |
| Series + route | `get_activity_details(id, maxchart=2000, maxpoly=4000)` | `metricDescriptors[].key` e.g. `directHeartRate` with `metricsIndex`; rows in `activityDetailMetrics[].metrics`; route in `geoPolylineDTO.polyline` (downsampled to 500 to 2200 points) |
| HR zones of a run | `get_activity_hr_in_timezones(id)` | |
| Full-resolution data | `download_activity(id, Garmin.ActivityDownloadFormat.ORIGINAL)` | Zip containing the FIT file |
| User HR zones | `get_heart_rate_zones()` | |
| Garmin PRs | `get_personal_record()` | |
| Profile check | `get_user_profile()` | Cheap validity check; `get_full_name()` can be None on some login paths |
| Devices | `get_device_last_used()` -> `userDeviceId`; `get_devices()` | `productDisplayName` may be None; push response carries `deviceName` |
| Create workout | `upload_running_workout(RunningWorkout)` -> `{"workoutId": ...}` | `upload_strength_workout(...)` for strength |
| Change | `update_workout(id, json)` (full PUT), `delete_workout(id)` | |
| Calendar | `schedule_workout(workout_id, "YYYY-MM-DD")` -> has a schedule id; `unschedule_workout(schedule_id)`; `get_scheduled_workouts(year, month)` -> `calendarItems[]` with `itemType == "workout"`, `workoutId`, `id` (schedule id), `date`, `title` | Month is 1-based in the call |
| Push to watch | `push_workout_to_device(workout_id, device_id)` | Response `[{"messageStatus": "new", "deviceName": ...}]`; the watch gets it on the next Garmin Connect app sync |

## Workout model (from `garminconnect.workout`)

```python
from garminconnect.workout import (RunningWorkout, WorkoutSegment, PaceTarget, pace_to_mps,
    create_warmup_step, create_targeted_interval_step, create_recovery_step, create_cooldown_step, create_repeat_group)
target = PaceTarget(lower_limit=pace_to_mps(5, 20, "km"), upper_limit=pace_to_mps(5, 0, "km"))  # slower pace is the lower limit (m/s)
steps = [create_warmup_step(600, step_order=1),
         create_repeat_group(4, [create_targeted_interval_step(180, 3, target), create_recovery_step(120, 4)], step_order=2),
         create_cooldown_step(300, step_order=5)]
RunningWorkout(workoutName=..., estimatedDurationInSecs=2100,
               workoutSegments=[WorkoutSegment(segmentOrder=1, sportType={"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}, workoutSteps=steps)])
```
Verified on an Instinct 2 Solar: the workout showed on the watch with per-step pace targets after a Garmin Connect app sync.
