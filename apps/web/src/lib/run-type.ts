import { RACE_EVENT_TYPE } from "@running-coach/shared";
import { sessionTypeName } from "./session-type";

/**
 * The word for a run's type, or null when the app shows none. Today only a run marked as a race in Garmin
 * Connect has one, named like the plan's race session; the plan's other types come when a plan links runs
 * to sessions. The chip and the rows' screen-reader names read it from here, so they never disagree.
 */
export function runTypeName(eventType: string | null): string | null {
  return eventType === RACE_EVENT_TYPE ? sessionTypeName("race") : null;
}
