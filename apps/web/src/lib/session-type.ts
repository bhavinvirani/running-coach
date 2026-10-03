import { SESSION_TYPE_NAMES, type SessionType } from "@running-coach/shared";

/**
 * A session type as a word, from the shared list the watch's workout names read too, so the chip, the
 * screen-reader names and Garmin never disagree.
 */
export function sessionTypeName(type: SessionType): string {
  return SESSION_TYPE_NAMES[type];
}

/**
 * Each type's fixed color as a whole class name, so Tailwind finds it in the source. Race practice shares
 * the race color: both are run at race pace. Only for the dot or bar beside a type (web-ui rule).
 */
const SESSION_TYPE_BACKGROUNDS: Readonly<Record<SessionType, string>> = {
  easy: "bg-type-easy",
  intervals: "bg-type-intervals",
  tempo: "bg-type-tempo",
  long: "bg-type-long",
  race_practice: "bg-type-race",
  race: "bg-type-race",
  strength: "bg-type-strength",
  rest: "bg-type-rest",
};

export function sessionTypeBackground(type: SessionType): string {
  return SESSION_TYPE_BACKGROUNDS[type];
}
