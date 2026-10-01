# Backlog: vertical slices in build order

Temporary. After approval each slice becomes a GitHub issue labeled `slice` (issue number = slice number) and this file is deleted. Each slice is one session and one PR.

## Slice 1: Walking skeleton, one real run

- Outcome: the deployed app on Render shows your latest Garmin run (date, distance, time, pace, avg HR) on the Today tab after you log in and press Sync. A CLI (`pnpm garmin:connect`) logs in on your laptop, handles 2FA in the terminal, and uploads the encrypted token bundle for the seeded owner account.
- Acceptance: login works in iPhone Safari and the installed PWA; warm sync shows the run in under 60 s; a refresh changes the stored bundle (write-back verified); expired or invalid bundle shows "Garmin login expired. Reconnect in Settings." and stores nothing; Garmin 429 or outage shows an error state with Retry; cold start shows the waking state; memory stays under 400 MB on Render; the Garmin service has a fixture mode for CI e2e.
- This slice is the datacenter-IP test: a successful sync from Render closes that risk.
- Packages: shared, api, garmin, web. e2e: login, sync, Today; screenshot Today.

## Slice 2: Full history import and run list

- Outcome: Import pulls every run newest-first with progress shown; the Progress tab lists runs by week with weekly distance totals.
- Acceptance: imported count equals Garmin's; killing the process mid-import resumes from the cursor; running twice creates no duplicates and edited activities update; treadmill (no GPS), manual and missing-HR runs import with nulls; non-running activities are skipped; a 429 pauses and resumes later; overlapping import and sync for one user is impossible.
- Packages: api (pg-boss introduced here), garmin, shared, web. e2e: import, list; screenshot Progress list.

## Slice 3: Run detail

- Outcome: tapping a run shows distance, time, avg pace, elevation, avg HR, cadence, calories; splits per km with pace and HR; laps chart; HR zones from your Garmin zones; cadence and elevation charts; route map.
- Acceptance: values match Garmin Connect within rounding; treadmill runs show no map and say why; missing HR hides zones with a note; a split faster than 2:00/km is flagged as a GPS glitch and excluded from charts; charts readable at 390 px; metric units by default.
- Packages: web, api, shared (streams from the FIT file). e2e: run detail; screenshots of stats, splits, charts, map.

## Slice 4: Personal bests and badges

- Outcome: Progress shows PB badges for 1K, 1 mi, 2 mi, 5K, 5 mi, 10K, 15K, 10 mi, 20K, half and marathon with time and date; a new PB is flagged after sync.
- Acceptance: best efforts computed from continuous segments of imported runs match your known PBs (5K 27:05, 10K 54:41, 10 mi 1:28:26, half 1:56:12); treadmill and manual runs excluded; GPS-glitch segments rejected; recompute is idempotent; Garmin's own PR list shown for comparison.
- Packages: engine (best-effort algorithm, TDD), api, web, shared. e2e: badges screenshot.

## Slice 5: Sync everywhere and the daily cron

- Outcome: sync runs on app open, on the Sync button and daily from GitHub Actions; Settings shows Garmin status and last sync; an expired connection shows a reconnect prompt.
- Acceptance: app open syncs at most once per 10 min; two cron fires in a row produce one job (deterministic id); a sync while one is running is skipped; the cron endpoint rejects a wrong secret; expired bundle sets status to reconnect without a retry storm; last sync time visible.
- Packages: api, web, .github. e2e: sync states; screenshot Settings.

## Slice 6: Goal and plan generation

- Outcome: set a goal (race distance, date, optional target time, or general fitness), days per week and long-run day; the engine generates a plan; the Plan tab shows weeks with distance totals and color-coded sessions (easy, intervals, tempo, long, race practice, strength, rest).
- Acceptance: identical inputs give identical plans; every engine rule has a unit test and holds across generated plans; paces from the VDOT of the best recent race, or an entered recent time; conflicts are reported (marathon on 3 days hits the long-run cap); a race date too close yields the shortest valid plan with a warning; regenerating keeps history. No Claude in this slice.
- Packages: engine (TDD), shared, api, web. e2e: set goal, see plan; screenshots of calendar and week.

## Slice 7: Workouts on the watch

- Outcome: the next 7 days of sessions appear on the Instinct as structured workouts with pace targets; moving, adding or deleting a session in the calendar updates Garmin.
- Acceptance: Garmin workout and schedule IDs tracked; re-push is idempotent; reschedule moves the Garmin entry; delete removes only ours; third-party workouts in the window are listed with an offer to unschedule; a Garmin outage mid-batch records partial state and retries; a race-date change regenerates and re-syncs.
- Packages: api, garmin, engine (step builder), shared, web. e2e: push and calendar edit with fixtures; you confirm on the watch once.

## Slice 8: Claude key and post-run insight

- Outcome: Settings takes your Claude key (validated with a free call, stored encrypted) and a coach detail level; after each synced run an insight card says what happened, what it means and what to do next, with numbers, and stores thumbs up or down.
- Acceptance: invalid or expired key shows a clear message; quota or timeout retries with backoff then shows "Coach unavailable, will retry"; refusal or max_tokens yields the fallback card; output validated with zod; prompt is a versioned file; no key hides cards behind one action; voice rules enforced by the prompt and checked by an eval fixture.
- Packages: api (analyze-run job, prompts), shared, web. e2e: add key against a fake endpoint; insight card screenshot with seeded data.

## Slice 9: Adaptation after each run

- Outcome: after each run the coach proposes small changes (scale or swap the next session); the engine clamps and applies them; missed sessions are dropped; a "not feeling 100%" pause for illness or injury applies the re-entry rules; changes reach the watch.
- Acceptance: deltas outside caps are clamped and logged; a missed session is never rescheduled; a 7 or 14 day pause reduces volume per the rules; a pain or illness flag yields rest advice and a professional pointer; unit tests per rule.
- Packages: engine, api, web, shared, prompts. e2e: pause flow; screenshot adjusted week.

## Slice 10: Weekly review and next-week preview

- Outcome: a weekly review card (what happened, what it means, next week) with a preview of next week's sessions; bigger plan changes within the caps.
- Acceptance: runs once per user per week (deterministic job id) on cron or first open after the week ends; thumbs stored; plan changes clamped; invalid output yields the fallback; past reviews visible.
- Packages: api, engine, web, shared, prompts. e2e: review card screenshot.

## Slice 11: Strength sessions and race-day plan

- Outcome: plans include strength and mobility sessions pushed as Garmin strength workouts; a race-day pacing and fueling plan for the goal race.
- Acceptance: a strength workout appears on the watch with sets and reps; the race plan lists km splits at target pace with a margin, fueling by duration, and a "not medical advice" note; both validated by zod.
- Packages: engine, api, garmin, web, prompts. e2e: race plan screenshot; you confirm the strength workout on the watch once.

## Slice 12: Setup flow and settings

- Outcome: a first-time setup wizard (account, Claude key, connect Garmin with email, password and 2FA in the web UI, import, goal, plan, watch); Settings offers reconnect and disconnect, units (km or mi), HR zones and coach detail.
- Acceptance: the 2FA flow is two calls with in-memory state and a 5 min TTL; a wrong code allows retry; the password is never stored or logged; disconnect wipes the bundle and offers to remove our scheduled workouts; units convert everywhere including charts; HR zones editable and used in run detail.
- Packages: api, garmin, web, shared. e2e: the full setup flow with the fixture Garmin.
