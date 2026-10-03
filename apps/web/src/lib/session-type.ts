import type { SessionType } from "@running-coach/shared";

/** The one place a session type becomes a word; the chip and the screen-reader names read it from here. */
const SESSION_TYPE_NAMES: Readonly<Record<SessionType, string>> = {
  easy: "Easy",
  intervals: "Intervals",
  tempo: "Tempo",
  long: "Long run",
  race_practice: "Race practice",
  race: "Race",
  strength: "Strength",
  rest: "Rest",
};

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
