import {
  RE_ENTRY_LONG_BREAK_DAYS,
  RE_ENTRY_LONG_BREAK_FACTOR,
  RE_ENTRY_SHORT_BREAK_DAYS,
  RE_ENTRY_SHORT_BREAK_FACTOR,
} from "../constants";

/**
 * The share of recent volume a runner restarts at after time off. Null is a runner with no runs on
 * record: there is no recent volume to return to, so the plan starts as for a runner with no history.
 */
export function reEntryFactor(daysSinceLastRun: number | null): number {
  if (daysSinceLastRun === null) return 0;
  if (!Number.isInteger(daysSinceLastRun) || daysSinceLastRun < 0) {
    throw new RangeError(`daysSinceLastRun must be a whole number >= 0, got ${daysSinceLastRun}`);
  }
  if (daysSinceLastRun >= RE_ENTRY_LONG_BREAK_DAYS) return RE_ENTRY_LONG_BREAK_FACTOR;
  if (daysSinceLastRun >= RE_ENTRY_SHORT_BREAK_DAYS) return RE_ENTRY_SHORT_BREAK_FACTOR;
  return 1;
}
