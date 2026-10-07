import type { CoachDetail, Units } from "@running-coach/shared";

/** A unit setting in words, as its Settings row and its choice name it. */
export const unitsNames: Record<Units, string> = { km: "Kilometers", mi: "Miles" };

/** A coach detail level in words, as its Settings row and its choice name it. */
export const coachDetailNames: Record<CoachDetail, string> = {
  short: "Short",
  standard: "Standard",
  detailed: "Detailed",
};
