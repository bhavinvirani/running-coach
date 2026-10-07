import {
  MAX_MAX_HR,
  MIN_MAX_HR,
  MIN_ZONE_FLOOR_BPM,
  type HrZonesSource,
} from "@running-coach/shared";

export const hrZonesCopy = {
  title: "Heart rate zones",
  loading: "Loading heart rate zones",
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
export const sourceCaptions: Record<HrZonesSource, string> = {
  custom: "Your own zones. Each run's time in zone is counted from its heart rate.",
  garmin: "Garmin's zones, from your latest run with heart rate.",
  estimated: "Garmin's default shares of your highest heart rate in the last year.",
  none: "No run with heart rate yet. Type your max HR and the zones start at Garmin's default shares of it.",
};

/** Why Save zones sent nothing: the first problem with what is typed, naming the field. */
export const zonesProblems = {
  maxHr: `Max HR is a whole number from ${MIN_MAX_HR} to ${MAX_MAX_HR} bpm.`,
  zone1Floor: `Zone 1 starts at ${MIN_ZONE_FLOOR_BPM} bpm or more.`,
  rising: "Each zone starts above the one before it.",
  zone5BelowMax: "Zone 5 starts below max HR.",
  wholeBpm: (zone: number) => `Zone ${zone} starts at a whole number of bpm.`,
  wholePercent: (zone: number) => `Zone ${zone} starts at a whole percent of max HR.`,
} as const;
