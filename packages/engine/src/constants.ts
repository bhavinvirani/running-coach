import { GPS_GLITCH_PACE_S_PER_KM, METERS_PER_KM } from "@running-coach/shared";

// Stored on each plan so a plan can be traced to the rule set that produced it.
export const ENGINE_VERSION = "0.1.0";

// The 10% rule: weekly running volume rises at most 10% over the previous week.
export const WEEKLY_VOLUME_MAX_INCREASE = 0.1;

// Glitch window, not a per-sample check: a real PR run stalled 4 s then caught up 25 m in 1 s and
// Garmin's records include it, while every real run measured stayed under 6.1 m/s over 10 s.
export const GLITCH_WINDOW_S = 10;

// Shared units.ts GPS_GLITCH_PACE_S_PER_KM as a speed (8.33 m/s): one definition of a glitch app-wide.
export const GPS_GLITCH_SPEED_M_PER_S = METERS_PER_KM / GPS_GLITCH_PACE_S_PER_KM;

// Bump when the best-efforts rule changes, so the API recomputes every stored best effort.
export const BEST_EFFORTS_VERSION = 1;
