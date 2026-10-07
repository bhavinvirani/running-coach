import type { HrZonesSource } from "@running-coach/shared";

export const hrZonesCopy = {
  title: "Heart-rate zones",
  loading: "Loading heart-rate zones",
  empty: "No run with heart rate yet: sync one recorded with heart rate to see your zones.",
  openToday: "Open Today",
  zones: "Zones",
  maxHr: "Max HR",
  maxHrHelp: "Beats per minute. A new max HR keeps each zone's percent.",
  save: "Save zones",
  saving: "Saving zones…",
  saved: "Zones saved.",
  reset: "Reset to Garmin's",
} as const;

/** Zone 1 to 5 by what each is for; the API numbers them only. */
export const zoneNames = ["Recovery", "Endurance", "Tempo", "Threshold", "Anaerobic"] as const;

/** Where the zones on screen come from, and so how each run's time in zone is counted. */
export const sourceCaptions: Record<Exclude<HrZonesSource, "none">, string> = {
  custom: "Your own zones. Each run's time in zone is counted from its heart rate.",
  garmin: "Garmin's zones, from your latest run with heart rate.",
  estimated: "Garmin's default shares of your highest heart rate in the last year.",
};
